import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HistoryEvent, Profile, Project } from '../shared/contracts.js';
import { Store } from '../server/store.js';
import { Vault } from '../server/vault.js';
import type { Context } from '../server/advanced/common.js';
import type { AgentTurn } from '../server/advanced/agent-mission.js';
import { createMission, updateMissionClaims } from '../server/advanced/mission.js';
import { gitOk } from '../server/advanced/process.js';
import { cancelRuntime, invalidateRuntime, markReady, pauseRuntime, publishRuntime, runRuntime, scheduleWave, type MissionMemory, type MissionRuntime, type RuntimeTask } from '../server/advanced/runtime.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; vi.restoreAllMocks(); });

const task = (partial: Partial<RuntimeTask> & Pick<RuntimeTask, 'id' | 'role'>): RuntimeTask => ({
  key: partial.id, agentId: partial.role, title: partial.role, status: 'pending', dependsOn: [], paths: [], git: false, isolate: false, runs: 0, ...partial,
});

describe('ordonnancement du runtime', () => {
  it('laisse une tâche indépendante prête et bloque seulement sa dépendante', () => {
    const failed = task({ id: 'a', role: 'architect', status: 'failed' });
    const independent = task({ id: 'b', role: 'architect', status: 'pending', paths: ['src/b.js'] });
    const child = task({ id: 'c', role: 'coder', status: 'pending', dependsOn: ['a'], paths: ['src/a.js'] });
    const ready = markReady([failed, independent, child]);
    expect(ready.find((item) => item.id === 'b')?.status).toBe('ready');
    expect(ready.find((item) => item.id === 'c')?.status).toBe('blocked');
    const left = task({ id: 'l', role: 'architect', status: 'ready', paths: ['src/a.js'] });
    const right = task({ id: 'r', role: 'architect', status: 'ready', paths: ['src/b.js'] });
    const third = task({ id: 't', role: 'architect', status: 'ready', paths: ['src/c.js'] });
    expect(scheduleWave([left, right, third], 2).map((item) => item.id)).toEqual(['l', 'r']);
    expect(scheduleWave([left, right], 1).map((item) => item.id)).toEqual(['l']);
    const parent = task({ id: 'p', role: 'coder', status: 'ready', paths: ['src'] });
    const nested = task({ id: 'n', role: 'coder', status: 'ready', paths: ['src/a.js'] });
    expect(scheduleWave([parent, nested], 4).map((item) => item.id)).toEqual(['p']);
    const gitA = task({ id: 'g1', role: 'coder', status: 'ready', git: true });
    const gitB = task({ id: 'g2', role: 'coder', status: 'ready', git: true, paths: ['docs'] });
    expect(scheduleWave([gitA, gitB], 4).map((item) => item.id)).toEqual(['g1']);
    const manager = task({ id: 'git', role: 'git-manager', status: 'ready', git: true });
    expect(scheduleWave([manager, right], 4).map((item) => item.id)).toEqual(['r']);
    expect(scheduleWave([nested], 2, { paths: ['src'] })).toEqual([]);
  });
});

describe('runtime multi-agents', () => {
  let ctx: Context;
  let project: Project;
  let store: Store;
  const projects = new Map<string, Project>();
  const command = 'node --test tests/invoice.test.js';
  const secret = 'ghp_abcdefghijklmnopqrstuv';

  async function seed(projectPath: string, projectId: string): Promise<Project> {
    await mkdir(path.join(projectPath, 'src'), { recursive: true });
    await mkdir(path.join(projectPath, 'tests'), { recursive: true });
    const created: Project = { id: projectId, path: projectPath, name: projectId, trusted: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    projects.set(projectId, created);
    store.put('projects', created);
    await gitOk(created, ['init', '-b', 'main']);
    await gitOk(created, ['config', 'user.email', 'fixture@example.invalid']);
    await gitOk(created, ['config', 'user.name', 'Fixture']);
    await writeFile(path.join(projectPath, 'src', 'rate.js'), 'exports.vat = () => 0;\n');
    await writeFile(path.join(projectPath, 'src', 'invoice.js'), 'exports.label = () => "USD";\n');
    await writeFile(path.join(projectPath, 'tests', 'invoice.test.js'), 'const {test}=require("node:test"); const assert=require("node:assert/strict"); const {vat}=require("../src/rate.js"); const {label}=require("../src/invoice.js"); test("vat",()=>assert.equal(vat(),0.2)); test("label",()=>assert.equal(label(),"EUR"));\n');
    await gitOk(created, ['add', '.']);
    await gitOk(created, ['commit', '-m', 'init']);
    await gitOk(created, ['switch', '-c', 'cortex/fixture']);
    return created;
  }

  async function setup(): Promise<void> {
    root = await mkdtemp(path.join(os.tmpdir(), 'cortex-runtime-'));
    const vault = new Vault();
    vault.set('fixture-profile', 'fixture-secret-not-a-real-service-key');
    store = new Store(path.join(root, 'data', 'cortex.sqlite'));
    const profile: Profile = { id: 'fixture-profile', name: 'Local', providerId: 'mock', modelId: 'mock', hasSecret: true, createdAt: '2026-01-01T00:00:00.000Z' };
    store.put('profiles', profile);
    ctx = {
      store, vault, engine: { request: vi.fn() }, project: (id: string) => {
        const found = projects.get(id);
        if (!found) throw new Error(`projet absent ${id}`);
        return found;
      },
      createSession: vi.fn(async () => { throw new Error('OpenCode ne doit pas démarrer'); }),
      prompt: vi.fn(),
      history: (projectId: string, kind: string, title: string, detail: string) => {
        const event: HistoryEvent = { id: `${kind}-${Math.random()}`, projectId, kind, title, detail, createdAt: new Date().toISOString() };
        return store.put('history', event, projectId);
      },
    } as unknown as Context;
    project = await seed(path.join(root, 'repo'), 'project-one');
  }

  afterEach(() => store?.close());

  function mission(target = project, paths: { agentId: string; paths: string[] }[] = [{ agentId: 'agent', paths: ['src'] }]) {
    const created = createMission(ctx, target, { title: 'Facture', goal: 'TVA 0.2 et libellé EUR', profileId: 'fixture-profile', confirm: true });
    updateMissionClaims(ctx, target, created.id, { claims: paths, confirm: true });
    return created;
  }

  const fix = async (target = project): Promise<AgentTurn> => {
    await writeFile(path.join(target.path, 'src', 'rate.js'), 'exports.vat = () => 0.2;\n');
    await writeFile(path.join(target.path, 'src', 'invoice.js'), 'exports.label = () => "EUR";\n');
    return { blocked: false, invoked: true, permissionStop: false, reason: 'correctif simulé', model: 'mock/simulated-not-opencode', sessionId: 'session-sim', decisions: [{ action: 'edit', resources: ['src/rate.js', 'src/invoice.js'], decision: 'once' }] };
  };

  const claims = [{ agentId: 'a', paths: ['src/rate.js'] }, { agentId: 'b', paths: ['src/invoice.js'] }];

  it('exécute deux architectes disjoints sans modèle et ne les refait pas', async () => {
    await setup();
    const driver = vi.fn(() => fix());
    const parallel = await runRuntime(ctx, project, mission(project, claims).id, { command, confirm: true, through: 'architect', concurrency: 2 }, { driver });
    expect(driver).not.toHaveBeenCalled();
    expect(parallel.parallelWaves).toBeGreaterThanOrEqual(1);
    expect(parallel.status).toBe('paused');
    const architects = parallel.tasks.filter((item) => item.role === 'architect');
    expect(architects).toHaveLength(2);
    expect(architects.every((item) => item.status === 'passed' && item.runs === 1)).toBe(true);
    const serial = await runRuntime(ctx, project, mission(project, claims).id, { command, confirm: true, through: 'architect', concurrency: 1 }, { driver });
    expect(serial.parallelWaves).toBe(0);
    expect(serial.tasks.filter((item) => item.role === 'architect').every((item) => item.runs === 1 && item.status === 'passed')).toBe(true);
    const failedKey = `architect:a:${['src/rate.js'].join('|')}`;
    const refused = await runRuntime(ctx, project, mission(project, claims).id, { command, confirm: true, through: 'architect' }, { driver, failKeys: [failedKey] });
    expect(driver).not.toHaveBeenCalled();
    expect(refused.tasks.find((item) => item.key === failedKey)?.status).toBe('failed');
    expect(refused.tasks.find((item) => item.key.startsWith('architect:b:'))?.status).toBe('passed');
    expect(refused.tasks.find((item) => item.role === 'coder')?.status).toBe('blocked');
    expect(refused.status).toBe('failed');
    const created = mission(project, claims);
    const planned = await runRuntime(ctx, project, created.id, { command, confirm: true, through: 'architect' }, { driver });
    const resumed = await runRuntime(ctx, project, created.id, { command, confirm: true }, { driver });
    expect(driver).toHaveBeenCalledTimes(1);
    expect(resumed.tasks.filter((item) => item.role === 'architect').every((item) => item.runs === 1)).toBe(true);
    expect(planned.tasks.filter((item) => item.role === 'architect').every((item) => item.runs === 1)).toBe(true);
    expect(resumed.tasks.find((item) => item.role === 'coder')?.status).toBe('passed');
    expect(resumed.tasks.find((item) => item.role === 'reviewer')?.status).toBe('passed');
    expect(resumed.tasks.find((item) => item.role === 'git-manager')?.status).toBe('pending');
    expect(resumed.remoteCertified).toBe(false);
    expect(ctx.createSession).not.toHaveBeenCalled();
  });

  it('reprend depuis SQLite, invalide sans second modèle et retire les secrets', async () => {
    await setup();
    const created = mission();
    const driver = vi.fn(() => fix());
    const proven = await runRuntime(ctx, project, created.id, { command, confirm: true, instruction: `Objectif ${secret} à garder hors mémoire.` }, { driver });
    expect(proven.tasks.find((item) => item.role === 'reviewer')?.status).toBe('passed');
    expect(driver).toHaveBeenCalledTimes(1);
    const memory = store.get<MissionMemory>('memories', created.id);
    expect(memory?.schemaVersion).toBe(1);
    expect(memory?.objective).toContain('[REDACTED]');
    expect(JSON.stringify(memory)).not.toContain('ghp_');
    expect(memory?.sessions).toContain('session-sim');
    invalidateRuntime(ctx, project, created.id, { confirm: true, keys: ['coder'] });
    const again = await runRuntime(ctx, project, created.id, { command, confirm: true }, { driver });
    expect(driver).toHaveBeenCalledTimes(1);
    expect(again.tasks.find((item) => item.role === 'coder')?.runs).toBe(2);
    expect(again.tasks.find((item) => item.role === 'architect')?.runs).toBe(1);
    expect(store.get<MissionMemory>('memories', created.id)?.version).toBe(2);
    const filename = store.filename;
    store.close();
    const raw = Buffer.concat([await readFile(filename), await readFile(`${filename}-wal`).catch(() => Buffer.alloc(0))]);
    expect(raw.includes(Buffer.from('ghp_'))).toBe(false);
    store = new Store(filename);
    ctx = { ...ctx, store } as Context;
    const persisted = store.get<MissionRuntime>('runtimes', created.id);
    const remembered = store.get<MissionMemory>('memories', created.id);
    expect(persisted?.tasks.find((item) => item.role === 'coder')?.runs).toBe(2);
    expect(remembered?.objective).not.toContain('ghp_');
    expect(remembered?.sessions).toEqual(['session-sim']);
    const resumed = await runRuntime(ctx, project, created.id, { command, confirm: true }, { driver });
    expect(driver).toHaveBeenCalledTimes(1);
    expect(resumed.tasks.find((item) => item.role === 'coder')?.runs).toBe(2);
    expect(resumed.tasks.find((item) => item.role === 'architect')?.runs).toBe(1);
  });

  it('bloque conflit et périmètre vide, refuse main et l’annulation, et pause entre les tâches', async () => {
    await setup();
    const driver = vi.fn(() => fix());
    const conflicted = await runRuntime(ctx, project, mission(project, [{ agentId: 'a', paths: ['src'] }, { agentId: 'b', paths: ['src/rate.js'] }]).id, { command, confirm: true }, { driver });
    expect(conflicted.status).toBe('blocked');
    const empty = await runRuntime(ctx, project, mission(project, [{ agentId: 'a', paths: [] }]).id, { command, confirm: true }, { driver });
    expect(empty.status).toBe('blocked');
    expect(driver).not.toHaveBeenCalled();
    await gitOk(project, ['switch', 'main']);
    await expect(runRuntime(ctx, project, mission().id, { command, confirm: true }, { driver })).rejects.toMatchObject({ code: 'PROTECTED_BRANCH' });
    await gitOk(project, ['switch', 'cortex/fixture']);
    const cancelled = mission();
    cancelRuntime(ctx, project, cancelled.id, { confirm: true });
    await expect(runRuntime(ctx, project, cancelled.id, { command, confirm: true }, { driver })).rejects.toMatchObject({ code: 'MISSION_CLOSED' });
    const created = mission();
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let started: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { started = resolve; });
    const running = runRuntime(ctx, project, created.id, { command, confirm: true }, { driver: vi.fn(async () => { started(); pauseRuntime(ctx, project, created.id, { confirm: true }); await hold; return fix(); }) });
    await gate;
    release();
    const paused = await running;
    expect(paused.status).toBe('paused');
    expect(paused.control).toBe('pause');
    expect(paused.tasks.find((item) => item.role === 'coder')?.status).toBe('passed');
    expect(paused.tasks.find((item) => item.role === 'tester')?.status).toBe('pending');
    expect(store.get<MissionMemory>('memories', created.id)?.decisions.some((item) => item.text.includes('pas au milieu'))).toBe(true);
    expect(driver).not.toHaveBeenCalled();
  });

  it('annule un test affaibli, épuise les tentatives et commit seulement le correctif', async () => {
    await setup();
    const before = await readFile(path.join(project.path, 'tests', 'invoice.test.js'), 'utf8');
    const tamper = vi.fn(async (): Promise<AgentTurn> => {
      await writeFile(path.join(project.path, 'tests', 'invoice.test.js'), 'const {test}=require("node:test"); test.skip("vat",()=>{});\n');
      return { blocked: false, invoked: true, permissionStop: false, reason: 'test affaibli', model: 'mock/simulated-not-opencode', decisions: [{ action: 'edit', resources: ['tests/invoice.test.js'], decision: 'once' }] };
    });
    const blocked = await runRuntime(ctx, project, mission().id, { command, confirm: true, testPolicy: 'deny' }, { driver: tamper });
    expect(blocked.status).toBe('blocked');
    expect(await readFile(path.join(project.path, 'tests', 'invoice.test.js'), 'utf8')).toBe(before);
    const noop = vi.fn(async (): Promise<AgentTurn> => ({ blocked: false, invoked: true, permissionStop: false, reason: 'rien', model: 'mock/simulated-not-opencode', decisions: [] }));
    const failed = await runRuntime(ctx, project, mission().id, { command, confirm: true, maxAttempts: 1 }, { driver: noop });
    expect(failed.status).toBe('failed');
    expect(noop).toHaveBeenCalledTimes(1);
    await expect(publishRuntime(ctx, project, failed.missionId, { confirm: true, message: 'feat: taux', allowCommit: true })).rejects.toMatchObject({ code: 'MISSION_NOT_PROVEN' });
    const created = mission();
    const proven = await runRuntime(ctx, project, created.id, { command, confirm: true }, { driver: vi.fn(() => fix()) });
    expect(proven.tasks.find((item) => item.role === 'reviewer')?.status).toBe('passed');
    await expect(publishRuntime(ctx, project, created.id, { confirm: true, message: 'feat: taux' })).rejects.toMatchObject({ code: 'PUBLISH_PERMISSION' });
    const published = await publishRuntime(ctx, project, created.id, { confirm: true, message: 'feat: taux et libelle', allowCommit: true });
    expect(published.tasks.find((item) => item.role === 'git-manager')?.status).toBe('passed');
    expect(published.remoteCertified).toBe(false);
    expect(await gitOk(project, ['log', '-1', '--format=%s'])).toContain('feat: taux et libelle');
    expect((await gitOk(project, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).trim().split('\n').sort()).toEqual(['src/invoice.js', 'src/rate.js']);
  });

  it('isole deux worktrees hors du dépôt sans les fusionner', async () => {
    await setup();
    const ran = await runRuntime(ctx, project, mission(project, claims).id, { command, confirm: true, through: 'architect', isolate: true }, { driver: vi.fn(() => fix()) });
    expect(ran.parallelWaves).toBeGreaterThanOrEqual(1);
    const trees = ran.tasks.filter((item) => item.role === 'architect').map((item) => item.worktree || '');
    expect(trees).toHaveLength(2);
    for (const tree of trees) {
      expect(tree.startsWith(`${project.path}${path.sep}`)).toBe(false);
      expect(path.dirname(tree)).toBe(root);
      expect((await readdir(tree)).length).toBeGreaterThan(0);
    }
    expect((await gitOk(project, ['rev-list', '--count', 'HEAD'])).trim()).toBe('1');
    expect((await gitOk(project, ['worktree', 'list'])).split('\n').length).toBeGreaterThanOrEqual(3);
    expect((await gitOk(project, ['status', '--porcelain'])).trim()).toBe('');
  }, 20_000);

  it('ne partage pas les verrous entre projets et bloque le même périmètre', async () => {
    await setup();
    const other = await seed(path.join(root, 'repo-b'), 'project-two');
    const first = mission();
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let started: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { started = resolve; });
    let released = false;
    const running = runRuntime(ctx, project, first.id, { command, confirm: true }, { driver: vi.fn(async () => { started(); await hold; return fix(); }) });
    await gate;
    const second = mission(project, [{ agentId: 'other', paths: ['src/invoice.js'] }]);
    const waiting = await runRuntime(ctx, project, second.id, { command, confirm: true }, { driver: vi.fn(() => fix()) });
    expect(waiting.status).toBe('blocked');
    expect(store.get<MissionMemory>('memories', second.id)?.decisions.at(-1)?.text).toContain('Verrou');
    const foreign = await runRuntime(ctx, other, mission(other, claims).id, { command, confirm: true }, { driver: vi.fn(() => fix(other)) });
    expect(released).toBe(false);
    expect(foreign.status).toBe('paused');
    expect(foreign.tasks.find((item) => item.role === 'reviewer')?.status).toBe('passed');
    released = true;
    release();
    const done = await running;
    expect(done.tasks.find((item) => item.role === 'reviewer')?.status).toBe('passed');
  }, 20_000);
});
