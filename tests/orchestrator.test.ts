import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HistoryEvent, Profile, Project } from '../shared/contracts.js';
import { Store } from '../server/store.js';
import { Vault } from '../server/vault.js';
import type { Context } from '../server/advanced/common.js';
import type { AgentTurn } from '../server/advanced/agent-mission.js';
import { createMission, updateMissionClaims } from '../server/advanced/mission.js';
import { cancelOrchestrator, pauseOrchestrator, publishOrchestration, runOrchestrator, selectRunnable, type OrchestratorTask } from '../server/advanced/orchestrator.js';
import { gitOk } from '../server/advanced/process.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; vi.restoreAllMocks(); });

const task = (partial: Partial<OrchestratorTask> & Pick<OrchestratorTask, 'id' | 'role'>): OrchestratorTask => ({
  key: partial.id, title: partial.role, status: 'pending', dependsOn: [], paths: [], git: false, runs: 0, ...partial,
});

describe('ordonnancement sans chevauchement', () => {
  it('lance ensemble les tâches disjointes et sérialise Git et les chemins parents', () => {
    const left = task({ id: 'a', role: 'planner', paths: ['src/a.js'] });
    const right = task({ id: 'b', role: 'planner', paths: ['src/b.js'] });
    expect(selectRunnable([left, right]).map((item) => item.id).sort()).toEqual(['a', 'b']);
    const parent = task({ id: 'p', role: 'coder', paths: ['src'] });
    const child = task({ id: 'c', role: 'coder', paths: ['src/a.js'] });
    expect(selectRunnable([parent, child]).map((item) => item.id)).toEqual(['p']);
    const first = task({ id: 'g1', role: 'publisher', git: true });
    const second = task({ id: 'g2', role: 'publisher', git: true });
    expect(selectRunnable([first, second]).map((item) => item.id)).toEqual(['g1']);
    expect(selectRunnable([child], { paths: ['src'] })).toEqual([]);
  });
});

describe('orchestrateur de mission', () => {
  let ctx: Context;
  let project: Project;
  let store: Store;
  const command = 'node --test tests/invoice.test.js';

  async function setup(): Promise<void> {
    root = await mkdtemp(path.join(os.tmpdir(), 'cortex-orchestrator-'));
    const projectPath = path.join(root, 'repo');
    await mkdir(path.join(projectPath, 'src'), { recursive: true });
    await mkdir(path.join(projectPath, 'tests'), { recursive: true });
    project = { id: 'project-one', path: projectPath, name: 'Fixture', trusted: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const vault = new Vault();
    vault.set('fixture-profile', 'fixture-secret-not-a-real-service-key');
    store = new Store(path.join(root, 'data', 'cortex.sqlite'));
    store.put('projects', project);
    const profile: Profile = { id: 'fixture-profile', name: 'Local', providerId: 'mock', modelId: 'mock', hasSecret: true, createdAt: project.createdAt };
    store.put('profiles', profile);
    ctx = {
      store, vault, engine: { request: vi.fn() }, project: () => project,
      createSession: vi.fn(async () => { throw new Error('OpenCode ne doit pas démarrer'); }),
      prompt: vi.fn(),
      history: (projectId: string, kind: string, title: string, detail: string) => {
        const event: HistoryEvent = { id: `${kind}-${Math.random()}`, projectId, kind, title, detail, createdAt: new Date().toISOString() };
        return store.put('history', event, projectId);
      },
    } as unknown as Context;
    await gitOk(project, ['init', '-b', 'main']);
    await gitOk(project, ['config', 'user.email', 'fixture@example.invalid']);
    await gitOk(project, ['config', 'user.name', 'Fixture']);
    await writeFile(path.join(projectPath, 'src', 'rate.js'), 'exports.vat = () => 0;\n');
    await writeFile(path.join(projectPath, 'src', 'invoice.js'), 'exports.label = () => "USD";\n');
    await writeFile(path.join(projectPath, 'tests', 'invoice.test.js'), 'const {test}=require("node:test"); const assert=require("node:assert/strict"); const {vat}=require("../src/rate.js"); const {label}=require("../src/invoice.js"); test("vat",()=>assert.equal(vat(),0.2)); test("label",()=>assert.equal(label(),"EUR"));\n');
    await gitOk(project, ['add', '.']);
    await gitOk(project, ['commit', '-m', 'init']);
    await gitOk(project, ['switch', '-c', 'cortex/fixture']);
  }

  afterEach(() => store?.close());

  function mission(paths: { agentId: string; paths: string[] }[] = [{ agentId: 'agent', paths: ['src'] }]) {
    const created = createMission(ctx, project, { title: 'Facture', goal: 'TVA 0.2 et libellé EUR', profileId: 'fixture-profile', confirm: true });
    updateMissionClaims(ctx, project, created.id, { claims: paths, confirm: true });
    return created;
  }

  const fix = async (): Promise<AgentTurn> => {
    await writeFile(path.join(project.path, 'src', 'rate.js'), 'exports.vat = () => 0.2;\n');
    await writeFile(path.join(project.path, 'src', 'invoice.js'), 'exports.label = () => "EUR";\n');
    return { blocked: false, invoked: true, permissionStop: false, reason: 'correctif simulé', model: 'mock/simulated-not-opencode', sessionId: 'session-sim', decisions: [{ action: 'edit', resources: ['src/rate.js'], decision: 'once' }] };
  };

  it('analyse deux périmètres disjoints sans modèle puis reprend sans refaire le plan', async () => {
    await setup();
    const created = mission([{ agentId: 'a', paths: ['src/rate.js'] }, { agentId: 'b', paths: ['src/invoice.js'] }]);
    const driver = vi.fn(fix);
    const planned = await runOrchestrator(ctx, project, created.id, { command, confirm: true, through: 'planner' }, { driver });
    expect(driver).not.toHaveBeenCalled();
    expect(planned.status).toBe('paused');
    const planners = planned.tasks.filter((item) => item.role === 'planner');
    expect(planners).toHaveLength(2);
    expect(planners.every((item) => item.status === 'completed' && item.runs === 1)).toBe(true);
    const resumed = await runOrchestrator(ctx, project, created.id, { command, confirm: true }, { driver });
    expect(driver).toHaveBeenCalledTimes(1);
    expect(resumed.tasks.filter((item) => item.role === 'planner').every((item) => item.runs === 1)).toBe(true);
    expect(resumed.tasks.find((item) => item.role === 'coder')?.status).toBe('completed');
    expect(resumed.tasks.find((item) => item.role === 'reviewer')?.status).toBe('completed');
    expect(resumed.tasks.find((item) => item.role === 'publisher')?.status).toBe('pending');
    expect(resumed.remoteCertified).toBe(false);
    expect(resumed.cost).toBeNull();
    expect(ctx.createSession).not.toHaveBeenCalled();
  });

  it('refuse la publication sans preuve, sans permission, et commit seulement le correctif', async () => {
    await setup();
    const created = mission();
    const failed = await runOrchestrator(ctx, project, created.id, { command, confirm: true, maxAttempts: 1 }, { driver: vi.fn(async () => ({ blocked: false, invoked: true, permissionStop: false, reason: 'rien', model: 'mock/simulated-not-opencode', decisions: [] })) });
    expect(failed.status).toBe('failed');
    await expect(publishOrchestration(ctx, project, created.id, { confirm: true, message: 'feat: taux', allowCommit: true })).rejects.toMatchObject({ code: 'MISSION_NOT_PROVEN' });
    const again = mission();
    const proven = await runOrchestrator(ctx, project, again.id, { command, confirm: true }, { driver: vi.fn(fix) });
    expect(proven.status).toBe('paused');
    await expect(publishOrchestration(ctx, project, again.id, { confirm: true, message: 'feat: taux' })).rejects.toMatchObject({ code: 'PUBLISH_PERMISSION' });
    const published = await publishOrchestration(ctx, project, again.id, { confirm: true, message: 'feat: taux et libelle', allowCommit: true });
    expect(published.tasks.find((item) => item.role === 'publisher')?.status).toBe('completed');
    expect(published.remoteCertified).toBe(false);
    expect(await gitOk(project, ['log', '-1', '--format=%s'])).toContain('feat: taux et libelle');
    expect((await gitOk(project, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).trim().split('\n').sort()).toEqual(['src/invoice.js', 'src/rate.js']);
  });

  it('bloque un conflit, main, l’annulation et une seconde mission sur les mêmes fichiers', async () => {
    await setup();
    const conflicted = mission([{ agentId: 'a', paths: ['src'] }, { agentId: 'b', paths: ['src/rate.js'] }]);
    const driver = vi.fn(fix);
    const blocked = await runOrchestrator(ctx, project, conflicted.id, { command, confirm: true }, { driver });
    expect(blocked.status).toBe('blocked');
    expect(driver).not.toHaveBeenCalled();
    await gitOk(project, ['switch', 'main']);
    const onMain = mission();
    await expect(runOrchestrator(ctx, project, onMain.id, { command, confirm: true }, { driver })).rejects.toMatchObject({ code: 'PROTECTED_BRANCH' });
    await gitOk(project, ['switch', 'cortex/fixture']);
    const cancelled = mission();
    cancelOrchestrator(ctx, project, cancelled.id, { confirm: true });
    await expect(runOrchestrator(ctx, project, cancelled.id, { command, confirm: true }, { driver })).rejects.toMatchObject({ code: 'MISSION_CLOSED' });
    expect(driver).not.toHaveBeenCalled();
    const first = mission();
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let started: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { started = resolve; });
    const running = runOrchestrator(ctx, project, first.id, { command, confirm: true }, { driver: vi.fn(async () => { started(); await hold; return fix(); }) });
    await gate;
    const second = mission([{ agentId: 'other', paths: ['src/invoice.js'] }]);
    const waiting = await runOrchestrator(ctx, project, second.id, { command, confirm: true }, { driver: vi.fn(fix) });
    expect(waiting.status).toBe('blocked');
    expect(waiting.decisions.at(-1)?.text).toContain('Verrou');
    release();
    const done = await running;
    expect(done.tasks.find((item) => item.role === 'reviewer')?.status).toBe('completed');
    pauseOrchestrator(ctx, project, first.id, { confirm: true });
    const paused = await runOrchestrator(ctx, project, first.id, { command, confirm: true }, { driver });
    expect(paused.status === 'paused' || paused.status === 'completed').toBe(true);
  });
});
