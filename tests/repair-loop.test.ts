import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { HistoryEvent, Profile, Project } from '../shared/contracts.js';
import { Store } from '../server/store.js';
import { Vault } from '../server/vault.js';
import type { Context } from '../server/advanced/common.js';
import { gitOk, runCommand, type Execution } from '../server/advanced/process.js';
import { detectClaimConflicts } from '../server/advanced/conflicts.js';
import { attachTestEvidence, cancelMission, createMission, updateMissionClaims, updateMissionStep, type Mission } from '../server/advanced/mission.js';
import { diagnoseFailure, runRepairLoop } from '../server/advanced/repair.js';
import { parsePorcelainZ, syncWorktreeClaims } from '../server/advanced/worktree-claims.js';
import { commitPaths, createAndCheckoutFeatureBranch, openPullRequest, publishStatus, pushFeatureBranch } from '../server/advanced/git-publish.js';

let root = '';
let store: Store | undefined;
afterEach(async () => { store?.close(); store = undefined; if (root) await rm(root, { recursive: true, force: true }); root = ''; vi.restoreAllMocks(); });

const passCmd = `node -e 'process.exit(0)'`;
const failCmd = `node -e 'console.error("FAIL src/app.js:1"); process.exit(1)'`;
const fixCmd = `node -e 'const fs=require("fs"); const t=fs.readFileSync("src/app.js","utf8"); if(!t.includes("value = 2")){ console.error("FAIL src/app.js:1"); process.exit(1); }'`;

function done(execution: Partial<Execution> & Pick<Execution, 'output' | 'exitCode'>): Execution {
  return { signal: null, timedOut: false, truncated: false, durationMs: 1, ...execution };
}

describe('diagnostic et porcelain', () => {
  it('cite le fichier en échec et lit le renommage -z dans l’ordre Git 2.39', () => {
    expect(diagnoseFailure('Error: FAIL src/app.js:1\n').files).toContain('src/app.js');
    expect(diagnoseFailure('node_modules/pkg/index.js ../secret.js').files).toEqual([]);
    const parsed = parsePorcelainZ('R  src/a-renamed.js\0src/a.js\0D  src/b.js\0?? src/c.js\0?? ../secret.js\0');
    expect(parsed.changes).toEqual([
      { path: 'src/a-renamed.js', status: 'renamed', from: 'src/a.js' },
      { path: 'src/b.js', status: 'deleted' },
      { path: 'src/c.js', status: 'added' },
    ]);
    expect(parsed.rejected).toContain('../secret.js');
    expect(detectClaimConflicts([
      { agentId: 'a', paths: ['src'] },
      { agentId: 'b', paths: ['src/b.js'] },
    ]).map((item) => item.path).sort()).toEqual(['src', 'src/b.js']);
  });
});

describe('boucle de correction et publication simulée', () => {
  let ctx: Context;
  let project: Project;

  async function setup(): Promise<void> {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cortex-repair-')));
    const projectPath = path.join(root, 'repo');
    await mkdir(path.join(projectPath, 'src'), { recursive: true });
    project = { id: 'project-one', path: projectPath, name: 'Fixture', trusted: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const vault = new Vault();
    vault.set('fixture-profile', 'fixture-secret-not-a-real-service-key');
    const database = new Store(path.join(root, 'data', 'cortex.sqlite'));
    store = database;
    database.put('projects', project);
    database.put('profiles', { id: 'fixture-profile', name: 'Local', providerId: 'mock', modelId: 'mock', hasSecret: true, createdAt: project.createdAt } satisfies Profile);
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
  }

  function closeEdits(mission: Mission): void {
    updateMissionStep(ctx, project, mission.id, { stepId: mission.steps[0]!.id, status: 'done', confirm: true });
    updateMissionStep(ctx, project, mission.id, { stepId: mission.steps[1]!.id, status: 'done', confirm: true });
  }

  async function initRepo(dir: string): Promise<void> {
    await mkdir(path.join(dir, 'src'), { recursive: true });
    const repo = { ...project, path: dir };
    await gitOk(repo, ['init', '-b', 'main']);
    await gitOk(repo, ['config', 'user.email', 'fixture@example.invalid']);
    await gitOk(repo, ['config', 'user.name', 'Fixture']);
    await writeFile(path.join(dir, 'src', 'a.js'), 'a\n');
    await writeFile(path.join(dir, 'src', 'b.js'), 'b\n');
    await gitOk(repo, ['add', '.']);
    await gitOk(repo, ['commit', '-m', 'init']);
  }

  function trackAgent(id: string, worktreePath: string): void {
    ctx.store.put('agents', { id, projectId: project.id, isolatedProjectId: id, name: id, task: 'edit', profileId: 'fixture-profile', mode: 'agent', branch: `cortex/${id}`, worktreePath, state: 'submitted', createdAt: project.createdAt, warning: 'test' }, project.id);
  }

  it('corrige un échec puis prouve la mission, sans appel modèle', async () => {
    await setup();
    await writeFile(path.join(project.path, 'src', 'app.js'), 'export const value = 1;\n');
    const created = createMission(ctx, project, { title: 'Corriger', goal: 'Rendre le test vert', profileId: 'fixture-profile', confirm: true });
    closeEdits(created);
    updateMissionClaims(ctx, project, created.id, { claims: [{ agentId: 'agent', paths: ['src/app.js'] }], confirm: true });
    const view = await runRepairLoop(ctx, project, created.id, { command: fixCmd, confirm: true, maxAttempts: 3, patches: [{ path: 'src/app.js', before: 'value = 1', after: 'value = 2' }] });
    expect(await readFile(path.join(project.path, 'src', 'app.js'), 'utf8')).toContain('value = 2');
    expect(view.evidence.map((item) => item.exitCode)).toEqual([1, 0]);
    expect(view.repairs?.map((item) => item.stopped ?? 'applied')).toEqual(['applied', 'passed']);
    expect(view.verdict).toMatchObject({ complete: true, status: 'proven' });
    expect(ctx.prompt).not.toHaveBeenCalled();
  });

  it('s’arrête au troisième échec avec un diagnostic, sans exit 0 ni contournement', async () => {
    await setup();
    const created = createMission(ctx, project, { title: 'Échec', goal: 'Diagnostiquer', profileId: 'fixture-profile', confirm: true });
    closeEdits(created);
    await expect(runRepairLoop(ctx, project, created.id, { command: 'exit 0', confirm: true })).rejects.toMatchObject({ code: 'REPAIR_COMMAND_DENIED' });
    const view = await runRepairLoop(ctx, project, created.id, { command: failCmd, confirm: true, maxAttempts: 3, patches: [] });
    expect(view.evidence).toHaveLength(3);
    expect(view.repairs?.map((item) => item.stopped)).toEqual(['no-fix', 'no-fix', 'no-fix']);
    expect(view.repairs?.at(-1)?.diagnosis).toContain('FAIL src/app.js:1');
    expect(view.verdict.complete).toBe(false);
    expect(ctx.prompt).not.toHaveBeenCalled();
  });

  it('annule entre deux tentatives et n’en lance pas une troisième', async () => {
    await setup();
    const created = createMission(ctx, project, { title: 'Stop', goal: 'Annuler', profileId: 'fixture-profile', confirm: true });
    const view = await runRepairLoop(ctx, project, created.id, { command: failCmd, confirm: true, maxAttempts: 3 }, { afterAttempt: () => cancelMission(ctx, project, created.id, { confirm: true }) });
    expect(view.verdict.status).toBe('cancelled');
    expect(view.verdict.complete).toBe(false);
    expect(view.evidence).toHaveLength(1);
    expect(view.repairs?.some((item) => item.stopped === 'cancelled')).toBe(true);
  });

  it('s’arrête sur timeout puis sur dépassement de budget', async () => {
    await setup();
    const created = createMission(ctx, project, { title: 'Temps', goal: 'Borner', profileId: 'fixture-profile', confirm: true });
    const timed = await runRepairLoop(ctx, project, created.id, { command: `node -e 'setTimeout(() => {}, 30000)'`, confirm: true, maxAttempts: 3, timeoutMs: 200 });
    expect(timed.repairs).toHaveLength(1);
    expect(timed.repairs?.[0]).toMatchObject({ stopped: 'timeout', timedOut: true });
    expect(timed.verdict.complete).toBe(false);
    const later = createMission(ctx, project, { title: 'Budget', goal: 'Borner encore', profileId: 'fixture-profile', confirm: true });
    let tick = 0;
    const budgeted = await runRepairLoop(ctx, project, later.id, { command: failCmd, confirm: true, maxAttempts: 3, budgetMs: 100 }, { clock: () => { tick += 1; return tick < 3 ? 0 : 5_000; } });
    expect(budgeted.evidence).toHaveLength(1);
    expect(budgeted.repairs?.map((item) => item.stopped)).toEqual(['no-fix', 'budget']);
    expect(budgeted.verdict.complete).toBe(false);
  });

  it('refuse d’affaiblir un test', async () => {
    await setup();
    await mkdir(path.join(project.path, 'tests'));
    const file = path.join(project.path, 'tests', 'app.test.js');
    await writeFile(file, `test('keep', () => {});\n`);
    const created = createMission(ctx, project, { title: 'Garde', goal: 'Ne pas sauter', profileId: 'fixture-profile', confirm: true });
    updateMissionClaims(ctx, project, created.id, { claims: [{ agentId: 'agent', paths: ['tests/app.test.js'] }], confirm: true });
    const command = `node -e 'console.error("FAIL tests/app.test.js:1"); process.exit(1)'`;
    const view = await runRepairLoop(ctx, project, created.id, { command, confirm: true, patches: [{ path: 'tests/app.test.js', before: 'test(', after: 'test.skip(' }] });
    expect(view.repairs?.[0]?.stopped).toBe('test-tamper');
    expect(await readFile(file, 'utf8')).toBe(`test('keep', () => {});\n`);
    expect(view.verdict.complete).toBe(false);
  });

  it('bloque deux agents sur le même fichier, pas deux fichiers voisins', async () => {
    await setup();
    const left = path.join(root, 'left');
    const right = path.join(root, 'right');
    await initRepo(left);
    await initRepo(right);
    await writeFile(path.join(left, 'src', 'a.js'), 'left\n');
    await writeFile(path.join(right, 'src', 'a.js'), 'right\n');
    trackAgent('a', left);
    trackAgent('b', right);
    const created = createMission(ctx, project, { title: 'Conflit', goal: 'Ne pas fusionner', profileId: 'fixture-profile', confirm: true });
    closeEdits(created);
    const blocked = await syncWorktreeClaims(ctx, project, created.id, { confirm: true });
    expect(blocked.conflicts.map((item) => item.path)).toContain('src/a.js');
    expect(blocked.verdict).toMatchObject({ complete: false, status: 'blocked' });
    const passing = await runCommand(ctx, project, { command: 'exit 0', confirm: true, kind: 'test' });
    const still = attachTestEvidence(ctx, project, created.id, { commandId: passing.id, confirm: true });
    expect(still.verdict).toMatchObject({ complete: false, status: 'blocked' });

    await writeFile(path.join(left, 'src', 'a.js'), 'gauche\n');
    await writeFile(path.join(right, 'src', 'a.js'), 'a\n');
    await writeFile(path.join(right, 'src', 'b.js'), 'droit\n');
    const siblings = await syncWorktreeClaims(ctx, project, created.id, { confirm: true });
    expect(siblings.conflicts).toEqual([]);
    expect(siblings.claims.flatMap((claim) => claim.paths).sort()).toEqual(['src/a.js', 'src/b.js']);
  });

  it('revendique un renommage, une suppression, et refuse un worktree symbolique', async () => {
    await setup();
    const wt = path.join(root, 'renamer');
    await initRepo(wt);
    const repo = { ...project, path: wt };
    await gitOk(repo, ['mv', 'src/a.js', 'src/a-renamed.js']);
    await gitOk(repo, ['rm', 'src/b.js']);
    await writeFile(path.join(wt, 'src', 'c.js'), 'c\n');
    await symlink('c.js', path.join(wt, 'src', 'link.js'));
    trackAgent('solo', wt);
    const created = createMission(ctx, project, { title: 'Arbre', goal: 'Voir les chemins', profileId: 'fixture-profile', confirm: true });
    const synced = await syncWorktreeClaims(ctx, project, created.id, { confirm: true });
    expect(synced.claims.flatMap((claim) => claim.paths).sort()).toEqual(['src/a-renamed.js', 'src/a.js', 'src/b.js', 'src/c.js']);
    expect(synced.rejected).toContain('src/link.js');
    expect(synced.verdict.complete).toBe(false);
    const link = path.join(root, 'link-wt');
    await symlink(wt, link);
    trackAgent('linked', link);
    await expect(syncWorktreeClaims(ctx, project, created.id, { confirm: true })).rejects.toMatchObject({ code: 'UNSAFE_WORKTREE_PATH' });
  });

  it('refuse la publication protégée, le push sans confirmation, et une authentification absente', async () => {
    await setup();
    const gh = vi.fn(async (): Promise<Execution> => done({ output: 'absent', exitCode: 1 }));
    const pushGit = vi.fn(async (): Promise<Execution> => done({ output: 'no', exitCode: 0 }));
    await expect(pushFeatureBranch(ctx, project, {})).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    await expect(openPullRequest(ctx, project, { title: 'PR', body: 'corps' })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    await expect(commitPaths(ctx, project, { message: 'nope', paths: ['README.md'], confirm: true })).rejects.toMatchObject({ code: 'PROTECTED_BRANCH' });
    await expect(pushFeatureBranch(ctx, project, { confirm: true, allowPush: true }, gh, pushGit)).rejects.toMatchObject({ code: 'PROTECTED_BRANCH' });
    await expect(openPullRequest(ctx, project, { title: 'PR', body: 'corps', confirm: true, allowPush: true }, gh)).rejects.toMatchObject({ code: 'PROTECTED_BRANCH' });
    expect(gh).not.toHaveBeenCalled();
    expect(pushGit).not.toHaveBeenCalled();
    await createAndCheckoutFeatureBranch(ctx, project, { name: 'cortex/mission-auth', confirm: true });
    await expect(pushFeatureBranch(ctx, project, { confirm: true, allowPush: true }, gh, pushGit)).rejects.toMatchObject({ code: 'GH_AUTH_REQUIRED' });
    expect(pushGit).not.toHaveBeenCalled();
    await gitOk(project, ['update-ref', 'refs/remotes/origin/cortex/mission-auth', 'HEAD']);
    await expect(openPullRequest(ctx, project, { title: 'PR', body: 'corps', confirm: true, allowPush: true }, gh)).rejects.toMatchObject({ code: 'GH_AUTH_REQUIRED' });
    const calls = gh.mock.calls as unknown as [string, string[]][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call[1]?.[0] === 'auth')).toBe(true);
  });

  it('commit le périmètre exact, pousse sans force et n’ouvre une PR simulée que si origin a le HEAD', async () => {
    await setup();
    await writeFile(path.join(project.path, 'note.txt'), 'bonjour\n');
    await createAndCheckoutFeatureBranch(ctx, project, { name: 'cortex/mission-push', confirm: true });
    const committed = await commitPaths(ctx, project, { message: 'feat: note locale', paths: ['note.txt'], confirm: true });
    expect(committed).toMatchObject({ files: ['note.txt'], pushed: false, remoteCertified: false });
    const gh = vi.fn(async (_executable: string, args: string[]): Promise<Execution> => done({ output: args[0] === 'auth' ? 'logged in\n' : 'https://github.com/example/fixture/pull/9\n', exitCode: 0 }));
    await expect(openPullRequest(ctx, project, { title: 'Mission', body: 'Pas de merge.', confirm: true, allowPush: true }, gh)).rejects.toMatchObject({ code: 'PUSH_REQUIRED' });
    expect(gh).not.toHaveBeenCalled();
    const pushGit = vi.fn(async (args: string[]): Promise<Execution> => done({ output: args.join(' '), exitCode: 0 }));
    const pushed = await pushFeatureBranch(ctx, project, { confirm: true, allowPush: true }, gh, pushGit);
    expect(pushed).toMatchObject({ pushed: true, forced: false, merged: false, remoteCertified: false });
    expect(pushGit).toHaveBeenCalledWith(['push', '--set-upstream', 'origin', 'cortex/mission-push']);
    expect(JSON.stringify(pushGit.mock.calls)).not.toMatch(/force/);
    await gitOk(project, ['update-ref', 'refs/remotes/origin/cortex/mission-push', 'HEAD']);
    const opened = await openPullRequest(ctx, project, { base: 'main', title: 'Mission', body: 'Simulation locale, aucune fusion.', confirm: true, allowPush: true }, gh);
    expect(opened).toMatchObject({ url: 'https://github.com/example/fixture/pull/9', merged: false, forced: false, remoteCertified: false });
    const status = await publishStatus(ctx, project);
    expect(status).toMatchObject({ currentBranch: 'cortex/mission-push', remoteCertified: false });
    expect(status.headFiles).toContain('note.txt');
    expect(status.latest).toMatchObject({ phase: 'pull-request', branch: 'cortex/mission-push', base: 'main', remoteCertified: false, url: opened.url });
    await writeFile(path.join(project.path, 'extra.txt'), 'de trop\n');
    await expect(commitPaths(ctx, project, { message: 'feat: trop large', paths: ['extra.txt', 'README.md'], confirm: true })).rejects.toMatchObject({ code: 'COMMIT_SCOPE' });
    const mission = createMission(ctx, project, { title: 'Ouverte', goal: 'Pas encore prouvée', profileId: 'fixture-profile', confirm: true });
    await expect(openPullRequest(ctx, project, { title: 'Mission', body: 'Encore.', confirm: true, allowPush: true }, gh)).rejects.toMatchObject({ code: 'MISSION_NOT_PROVEN' });
    expect(mission.verdict.complete).toBe(false);
  });

  it('retire l’état prouvé quand un test plus récent échoue', async () => {
    await setup();
    const created = createMission(ctx, project, { title: 'Régression', goal: 'Reouvrir', profileId: 'fixture-profile', confirm: true });
    closeEdits(created);
    const proven = await runRepairLoop(ctx, project, created.id, { command: passCmd, confirm: true, maxAttempts: 1 });
    expect(proven.verdict).toMatchObject({ complete: true, status: 'proven' });
    const again = await runRepairLoop(ctx, project, created.id, { command: failCmd, confirm: true, maxAttempts: 1 });
    expect(again.evidence.at(-1)?.exitCode).toBe(1);
    expect(again.verdict).toMatchObject({ complete: false, status: 'needs-evidence' });
  });
});
