import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import type { HistoryEvent, Profile, Project } from '../shared/contracts.js';
import { Store } from '../server/store.js';
import { Vault } from '../server/vault.js';
import type { Context } from '../server/advanced/common.js';
import { registerAdvancedRoutes, shutdownAdvanced } from '../server/routes-advanced.js';
import { gitOk, runCommand, type Execution } from '../server/advanced/process.js';
import { packContext } from '../server/advanced/context-budget.js';
import { detectClaimConflicts } from '../server/advanced/conflicts.js';
import { attachTestEvidence, completionVerdict, createMission, resumeMission, suggestBranch, updateMissionClaims, updateMissionStep, type Mission } from '../server/advanced/mission.js';
import { assertCortexBranch, assertFeatureBranch, buildPullRequestArgs, commitPaths, createAndCheckoutFeatureBranch, openPullRequest } from '../server/advanced/git-publish.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; vi.restoreAllMocks(); });

function mission(partial: Partial<Mission> = {}): Mission {
  return {
    id: 'm1', projectId: 'p', title: 'T', goal: 'But', profileId: 'profile', status: 'active',
    steps: [
      { id: 'a', title: 'Analyser', kind: 'analyze', status: 'done', required: true },
      { id: 'e', title: 'Modifier', kind: 'edit', status: 'done', required: true },
      { id: 't', title: 'Tester', kind: 'test', status: 'done', required: true },
    ],
    claims: [], conflicts: [], evidence: [{ id: 'ev', commandId: 'c', command: 'pnpm test', exitCode: 0, timedOut: false, truncated: false, createdAt: '2026-01-01T00:00:00.000Z' }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', resumeCount: 0, ...partial,
  };
}

describe('budget de contexte', () => {
  it('épingle les instructions et omet le surplus', () => {
    const packed = packContext([
      { id: 'late', kind: 'memory', title: 'Bruit', text: 'x'.repeat(400) },
      { id: 'rule', kind: 'instruction', title: 'Règle', text: 'Toujours prouver les tests.' },
      { id: 'empty', kind: 'recent', title: 'Vide', text: '   ' },
    ], 80);
    expect(packed.text.startsWith('[instruction]')).toBe(true);
    expect(packed.omitted).toContainEqual({ id: 'empty', kind: 'recent', reason: 'empty' });
    expect(packed.estimatedTokens).toBeLessThanOrEqual(packed.budget);
    expect(packed.included.some((item) => item.id === 'rule')).toBe(true);
  });
});

describe('conflits d’agents', () => {
  it('détecte fichier identique et préfixe de dossier, pas le même agent', () => {
    expect(detectClaimConflicts([
      { agentId: 'a', paths: ['src/app.ts'] },
      { agentId: 'a', paths: ['src/app.ts'] },
    ])).toEqual([]);
    const conflicts = detectClaimConflicts([
      { agentId: 'a', paths: ['src'] },
      { agentId: 'b', paths: ['src/app.ts', 'docs/readme.md'] },
    ]);
    expect(conflicts.map((item) => item.path).sort()).toEqual(['src', 'src/app.ts']);
    expect(conflicts.every((item) => item.agents.join() === 'a,b')).toBe(true);
  });
});

describe('verdict de mission', () => {
  it('refuse la clôture sans preuve, après un échec plus récent, ou avec conflit', () => {
    expect(completionVerdict(mission({ evidence: [] })).complete).toBe(false);
    expect(completionVerdict(mission({ evidence: [] })).status).toBe('needs-evidence');
    const regression = completionVerdict(mission({ evidence: [
      { id: '1', commandId: 'c', command: 'pnpm test', exitCode: 0, timedOut: false, truncated: false, createdAt: '1' },
      { id: '2', commandId: 'd', command: 'pnpm test', exitCode: 1, timedOut: false, truncated: false, createdAt: '2' },
    ] }));
    expect(regression.complete).toBe(false);
    expect(regression.status).toBe('needs-evidence');
    const blocked = completionVerdict(mission({ conflicts: [{ path: 'src/app.ts', agents: ['a', 'b'] }] }));
    expect(blocked).toMatchObject({ complete: false, status: 'blocked' });
    expect(completionVerdict(mission()).complete).toBe(true);
  });

  it('ne fabrique pas une branche protégée', () => {
    expect(suggestBranch('Réparer le Main !', 'ABC-123')).toBe('cortex/mission-reparer-le-main-abc123');
    expect(() => assertFeatureBranch('main')).toThrow(/protégée/i);
    expect(() => assertCortexBranch('feature/ok')).toThrow(/cortex\//);
    expect(assertCortexBranch('cortex/mission-ok')).toBe('cortex/mission-ok');
    const args = buildPullRequestArgs({ repo: 'cortexAI-2025/open-cortex-code', base: 'main', head: 'cortex/mission-ok', title: 'Mission', body: 'Preuve jointe.' });
    expect(args).toEqual(['pr', 'create', '--repo', 'cortexAI-2025/open-cortex-code', '--base', 'main', '--head', 'cortex/mission-ok', '--title', 'Mission', '--body', 'Preuve jointe.']);
    expect(args.join(' ')).not.toMatch(/merge|force/i);
    expect(() => buildPullRequestArgs({ repo: 'a/b', base: 'main', head: 'main', title: 'x', body: 'y' })).toThrow();
  });
});

describe('Git réel et mission, sans GitHub réseau', () => {
  let ctx: Context;
  let project: Project;
  let store: Store | undefined;
  let app: ReturnType<typeof express> | undefined;

  async function setup(): Promise<void> {
    root = await mkdtemp(path.join(os.tmpdir(), 'cortex-mission-'));
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath);
    project = { id: 'project-one', path: projectPath, name: 'Fixture', trusted: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const vault = new Vault();
    vault.set('fixture-profile', 'fixture-secret-not-a-real-service-key');
    const database = new Store(path.join(root, 'data', 'cortex.sqlite'));
    store = database;
    database.put('projects', project);
    const profile: Profile = { id: 'fixture-profile', name: 'Local', providerId: 'mock', modelId: 'mock', hasSecret: true, createdAt: project.createdAt };
    database.put('profiles', profile);
    ctx = {
      store: database, vault, engine: { request: vi.fn() }, project: () => project,
      createSession: vi.fn(), prompt: vi.fn(),
      history: (projectId: string, kind: string, title: string, detail: string) => {
        const event: HistoryEvent = { id: `${kind}-${Math.random()}`, projectId, kind, title, detail, createdAt: new Date().toISOString() };
        return database.put('history', event, projectId);
      },
    } as unknown as Context;
    await gitOk(project, ['init', '-b', 'main']);
    await gitOk(project, ['config', 'user.email', 'fixture@example.invalid']);
    await gitOk(project, ['config', 'user.name', 'Fixture']);
    await writeFile(path.join(projectPath, 'README.md'), 'original\n');
    await gitOk(project, ['add', 'README.md']);
    await gitOk(project, ['commit', '-m', 'init']);
    await gitOk(project, ['remote', 'add', 'origin', 'https://github.com/example/fixture.git']);
    app = express();
    app.use(express.json());
    registerAdvancedRoutes(app, ctx);
  }

  afterEach(() => { if (app) shutdownAdvanced(app); store?.close(); });

  it('refuse un commit sur main, puis commit uniquement sur cortex/', async () => {
    await setup();
    await writeFile(path.join(project.path, 'note.txt'), 'bonjour\n');
    await expect(commitPaths(ctx, project, { message: 'nope', paths: ['note.txt'], confirm: true })).rejects.toMatchObject({ code: 'PROTECTED_BRANCH' });
    expect((await gitOk(project, ['log', '--oneline'])).trim().split('\n')).toHaveLength(1);
    expect((await gitOk(project, ['branch', '--show-current'])).trim()).toBe('main');
    const created = await createAndCheckoutFeatureBranch(ctx, project, { name: 'cortex/mission-preuve', confirm: true });
    expect(created).toMatchObject({ branch: 'cortex/mission-preuve', merged: false });
    await expect(commitPaths(ctx, project, { message: 'secret', paths: ['.env'], confirm: true })).rejects.toMatchObject({ code: 'SENSITIVE_FILE' });
    const committed = await commitPaths(ctx, project, { message: 'feat: note locale', paths: ['note.txt'], confirm: true });
    expect(committed).toMatchObject({ pushed: false, merged: false, branch: 'cortex/mission-preuve' });
    expect((await gitOk(project, ['log', '-1', '--format=%s'])).trim()).toBe('feat: note locale');
    expect((await gitOk(project, ['branch', '--show-current'])).trim()).not.toBe('main');
  });

  it('n’ouvre pas de PR réelle et n’appelle pas gh tant que la branche est protégée', async () => {
    await setup();
    const runner = vi.fn(async (): Promise<Execution> => { throw new Error('gh ne doit pas être appelé'); });
    await expect(openPullRequest(ctx, project, { title: 'PR', body: 'corps', confirm: true, allowPush: true }, runner)).rejects.toMatchObject({ code: 'PROTECTED_BRANCH' });
    expect(runner).not.toHaveBeenCalled();
    await createAndCheckoutFeatureBranch(ctx, project, { name: 'cortex/mission-pr', confirm: true });
    const gh = vi.fn(async (): Promise<Execution> => ({ output: 'https://github.com/example/fixture/pull/7\n', exitCode: 0, signal: null, timedOut: false, truncated: false, durationMs: 1 }));
    const opened = await openPullRequest(ctx, project, { base: 'main', title: 'Mission', body: 'Pas de merge.', confirm: true, allowPush: true }, gh);
    expect(opened).toMatchObject({ url: 'https://github.com/example/fixture/pull/7', merged: false, forced: false, branch: 'cortex/mission-pr' });
    const call = (gh.mock.calls as unknown as [string, string[]][])[0];
    expect(call?.[0]).toBe('gh');
    expect(call?.[1]).not.toContain('merge');
    expect(call?.[1]).not.toContain('--force');
    await expect(openPullRequest(ctx, project, { title: 'Mission', body: 'corps', confirm: true }, gh)).rejects.toThrow();
  });

  it('attache une vraie commande de test et refuse de conclure avant elle', async () => {
    await setup();
    const created = createMission(ctx, project, { title: 'Preuve', goal: 'Montrer le verdict', profileId: 'fixture-profile', confirm: true });
    expect(created.verdict.complete).toBe(false);
    expect(created.suggestedBranch.startsWith('cortex/mission-')).toBe(true);
    const analyzed = updateMissionStep(ctx, project, created.id, { stepId: created.steps[0]!.id, status: 'done', confirm: true });
    updateMissionStep(ctx, project, created.id, { stepId: created.steps[1]!.id, status: 'done', confirm: true });
    expect(analyzed.verdict.complete).toBe(false);
    expect(() => updateMissionStep(ctx, project, created.id, { stepId: created.steps[2]!.id, status: 'done', confirm: true })).toThrow(/kind:test/);
    const failing = await runCommand(ctx, project, { command: 'exit 2', confirm: true, kind: 'test' });
    const notYet = attachTestEvidence(ctx, project, created.id, { commandId: failing.id, confirm: true });
    expect(notYet.verdict.complete).toBe(false);
    expect(notYet.verdict.status).toBe('needs-evidence');
    const passing = await runCommand(ctx, project, { command: 'exit 0', confirm: true, kind: 'test' });
    const proven = attachTestEvidence(ctx, project, created.id, { commandId: passing.id, confirm: true });
    expect(proven.verdict).toMatchObject({ complete: true, status: 'proven' });
    const blocked = updateMissionClaims(ctx, project, created.id, { claims: [{ agentId: 'un', paths: ['src/a.ts'] }, { agentId: 'deux', paths: ['src/a.ts'] }], confirm: true });
    expect(blocked.verdict).toMatchObject({ complete: false, status: 'blocked' });
    const resumed = resumeMission(ctx, project, created.id, { budgetTokens: 400 });
    expect(resumed.submitted).toBe(false);
    expect(resumed.brief).toContain('Ne pas déclarer');
    expect(resumed.estimatedTokens).toBeLessThanOrEqual(400);
    expect(ctx.prompt).not.toHaveBeenCalled();
  });
});
