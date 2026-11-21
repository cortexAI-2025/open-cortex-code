import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HistoryEvent, Profile, Project } from '../shared/contracts.js';
import { Store } from '../server/store.js';
import { Vault } from '../server/vault.js';
import type { Context } from '../server/advanced/common.js';
import { authorizeMissionAction, permissionStopsTurn, probeModel, runAgentMission, type AgentTurn } from '../server/advanced/agent-mission.js';
import { cancelMission, createMission, updateMissionClaims } from '../server/advanced/mission.js';
import { gitOk } from '../server/advanced/process.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; vi.restoreAllMocks(); });

const claims = [{ agentId: 'agent', paths: ['src/app.js'] }];
const fail = `node -e 'const fs=require("fs"); const t=fs.readFileSync("src/app.js","utf8"); if(!t.includes("value = 2")){ console.error("FAIL src/app.js:1"); process.exit(1);} '`;
const idle = (reason: string, extra: Partial<AgentTurn> = {}): AgentTurn => ({ blocked: false, invoked: true, permissionStop: false, reason, model: 'mock/simulated-not-opencode', sessionId: 'session-sim', decisions: [], ...extra });

describe('permissions du mode Agent', () => {
  const projectPath = '/workspace/proj';
  it('n’accorde edit qu’une fois, dans les claims, hors tests et hors secrets', () => {
    expect(authorizeMissionAction('edit', [`${projectPath}/src/app.js`], claims, projectPath)).toBe('once');
    expect(authorizeMissionAction('edit', ['src/app.js'], claims, projectPath)).toBe('once');
    expect(authorizeMissionAction('edit', ['../secret.js'], claims, projectPath)).toBe('reject');
    expect(authorizeMissionAction('edit', [`${projectPath}/.env`], claims, projectPath)).toBe('reject');
    expect(authorizeMissionAction('edit', ['tests/app.test.js'], [{ agentId: 'agent', paths: ['tests/app.test.js'] }], projectPath)).toBe('reject');
    expect(authorizeMissionAction('edit', ['src/other.js'], claims, projectPath)).toBe('reject');
    expect(authorizeMissionAction('shell', ['node --test'], claims, projectPath)).toBe('reject');
    expect(authorizeMissionAction('shell', ['git push origin main'], claims, projectPath)).toBe('reject');
    expect(permissionStopsTurn('shell', 'reject', ['node --test'])).toBe(false);
    expect(permissionStopsTurn('shell', 'reject', ['git push origin'])).toBe(true);
    expect(permissionStopsTurn('edit', 'reject', ['src/other.js'])).toBe(true);
    expect(permissionStopsTurn('edit', 'once', ['src/app.js'])).toBe(false);
  });

  it('bloque un endpoint local injoignable sans inventer de modèle', async () => {
    const profile: Profile = { id: 'p', name: 'Local', providerId: 'ollama', modelId: 'absent', baseUrl: 'http://127.0.0.1:9/v1', hasSecret: false, createdAt: '2026-01-01T00:00:00.000Z' };
    await expect(probeModel(profile, false)).resolves.toMatch(/injoignable|BLOCKED/);
    await expect(probeModel({ ...profile, baseUrl: undefined }, false)).resolves.toMatch(/BLOCKED/);
    await expect(probeModel({ ...profile, baseUrl: undefined }, true)).resolves.toBeNull();
  });
});

describe('boucle Agent, tests locaux réels, moteur simulé ou absent', () => {
  let ctx: Context;
  let project: Project;
  let store: Store;

  async function setup(): Promise<void> {
    root = await mkdtemp(path.join(os.tmpdir(), 'cortex-agent-'));
    const projectPath = path.join(root, 'repo');
    await mkdir(path.join(projectPath, 'src'), { recursive: true });
    project = { id: 'project-one', path: projectPath, name: 'Fixture', trusted: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const vault = new Vault();
    vault.set('fixture-profile', 'fixture-secret-not-a-real-service-key');
    store = new Store(path.join(root, 'data', 'cortex.sqlite'));
    store.put('projects', project);
    const profile: Profile = { id: 'fixture-profile', name: 'Local', providerId: 'mock', modelId: 'mock', hasSecret: true, createdAt: project.createdAt };
    store.put('profiles', profile);
    ctx = {
      store, vault, engine: { request: vi.fn() }, project: () => project,
      createSession: vi.fn(async () => { throw new Error('OpenCode ne doit pas démarrer dans ce test'); }),
      prompt: vi.fn(),
      history: (projectId: string, kind: string, title: string, detail: string) => {
        const event: HistoryEvent = { id: `${kind}-${Math.random()}`, projectId, kind, title, detail, createdAt: new Date().toISOString() };
        return store.put('history', event, projectId);
      },
    } as unknown as Context;
    await gitOk(project, ['init', '-b', 'main']);
    await gitOk(project, ['config', 'user.email', 'fixture@example.invalid']);
    await gitOk(project, ['config', 'user.name', 'Fixture']);
    await writeFile(path.join(projectPath, 'README.md'), 'original\n');
    await writeFile(path.join(projectPath, 'src', 'app.js'), 'export const value = 1;\n');
    await gitOk(project, ['add', '.']);
    await gitOk(project, ['commit', '-m', 'init']);
  }

  afterEach(() => store?.close());

  async function mission() {
    const created = createMission(ctx, project, { title: 'Corriger add', goal: 'value doit valoir 2', profileId: 'fixture-profile', confirm: true });
    updateMissionClaims(ctx, project, created.id, { claims, confirm: true });
    return created;
  }

  it('applique un changement produit par le pilote puis le prouve par un test réel', async () => {
    await setup();
    const created = await mission();
    let seen = '';
    const view = await runAgentMission(ctx, project, created.id, { command: fail, confirm: true, maxAttempts: 3 }, { driver: async (input) => {
      seen = input.diagnosis;
      await writeFile(path.join(project.path, 'src', 'app.js'), 'export const value = 2;\n');
      return idle('correctif simulé, pas une génération OpenCode');
    } });
    expect(seen).toContain('src/app.js');
    expect(view.verdict).toMatchObject({ complete: true, label: 'PROVEN' });
    expect(view.repairs?.at(-1)).toMatchObject({ stopped: 'passed', invoked: true, model: 'mock/simulated-not-opencode', applied: ['src/app.js'] });
    expect(await readFile(path.join(project.path, 'src', 'app.js'), 'utf8')).toContain('value = 2');
    expect(ctx.createSession).not.toHaveBeenCalled();
    expect(ctx.prompt).not.toHaveBeenCalled();
  });

  it('annule un correctif écrit alors que le modèle est bloqué', async () => {
    await setup();
    const created = await mission();
    const view = await runAgentMission(ctx, project, created.id, { command: fail, confirm: true }, { driver: async () => {
      await writeFile(path.join(project.path, 'src', 'app.js'), 'export const value = 2;\n');
      return { blocked: true, invoked: false, permissionStop: false, reason: 'Aucun modèle. BLOCKED.', decisions: [] };
    } });
    expect(view.verdict.label).toBe('BLOCKED');
    expect(view.verdict.complete).toBe(false);
    expect(await readFile(path.join(project.path, 'src', 'app.js'), 'utf8')).toBe('export const value = 1;\n');
    expect(ctx.createSession).not.toHaveBeenCalled();
  });

  it('s’arrête au bout de trois générations vides avec le diagnostic de test', async () => {
    await setup();
    const created = await mission();
    const view = await runAgentMission(ctx, project, created.id, { command: fail, confirm: true, maxAttempts: 3 }, { driver: async () => idle('aucune édition') });
    expect(view.repairs?.filter((item) => item.stopped === 'no-fix')).toHaveLength(3);
    expect(view.verdict).toMatchObject({ complete: false, label: 'FAILED' });
    expect(view.repairs?.at(-1)?.diagnosis).toContain('src/app.js');
    expect(await readFile(path.join(project.path, 'src', 'app.js'), 'utf8')).toContain('value = 1');
  });

  it('annule pendant la génération et ne prouve pas', async () => {
    await setup();
    const created = await mission();
    const view = await runAgentMission(ctx, project, created.id, { command: fail, confirm: true }, { driver: async () => {
      cancelMission(ctx, project, created.id, { confirm: true });
      return idle('annulation');
    } });
    expect(view.verdict).toMatchObject({ complete: false, status: 'cancelled', label: 'CANCELLED' });
  });

  it('n’appelle pas le pilote si le budget est déjà dépassé', async () => {
    await setup();
    const created = await mission();
    let ticks = 0;
    const driver = vi.fn(async () => idle('trop tard'));
    const view = await runAgentMission(ctx, project, created.id, { command: fail, confirm: true, budgetMs: 1_000 }, { driver, clock: () => (++ticks < 3 ? 0 : 50_000) });
    expect(driver).not.toHaveBeenCalled();
    expect(view.repairs?.at(-1)?.stopped).toBe('budget');
    expect(view.verdict.complete).toBe(false);
  });

  it('bloque avant OpenCode quand deux agents revendiquent le même fichier', async () => {
    await setup();
    const created = await mission();
    updateMissionClaims(ctx, project, created.id, { claims: [{ agentId: 'un', paths: ['src/app.js'] }, { agentId: 'deux', paths: ['src/app.js'] }], confirm: true });
    const driver = vi.fn(async () => idle('ne doit pas partir'));
    const view = await runAgentMission(ctx, project, created.id, { command: fail, confirm: true }, { driver });
    expect(driver).not.toHaveBeenCalled();
    expect(view.verdict.label).toBe('BLOCKED');
    expect(view.repairs?.at(-1)?.stopped).toBe('conflict');
  });

  it('restaure une édition hors claims ou un test affaibli', async () => {
    await setup();
    await mkdir(path.join(project.path, 'tests'));
    await writeFile(path.join(project.path, 'tests', 'app.test.js'), 'test("keep", () => {});\n');
    const created = await mission();
    const outside = await runAgentMission(ctx, project, created.id, { command: fail, confirm: true, maxAttempts: 1 }, { driver: async () => {
      await writeFile(path.join(project.path, 'src', 'other.js'), 'hors\n');
      return idle('hors périmètre');
    } });
    expect(outside.verdict.label).toBe('BLOCKED');
    expect(outside.repairs?.at(-1)?.stopped).toBe('scope');
    await expect(readFile(path.join(project.path, 'src', 'other.js'), 'utf8')).rejects.toThrow();
    const tamper = await runAgentMission(ctx, project, created.id, { command: fail, confirm: true, maxAttempts: 1 }, { driver: async () => {
      await writeFile(path.join(project.path, 'tests', 'app.test.js'), 'test.skip("keep", () => {});\n');
      return idle('tamper');
    } });
    expect(tamper.repairs?.at(-1)?.stopped).toBe('test-tamper');
    expect(await readFile(path.join(project.path, 'tests', 'app.test.js'), 'utf8')).toBe('test("keep", () => {});\n');
    expect(await readFile(path.join(project.path, 'tests', 'app.test.js'), 'utf8')).toBe('test("keep", () => {});\n');
    expect(tamper.verdict.complete).toBe(false);
  });

  it('refuse un fragment prédéfini sur la route agent', async () => {
    await setup();
    const created = await mission();
    await expect(runAgentMission(ctx, project, created.id, { command: fail, confirm: true, patches: [{ path: 'src/app.js', before: '1', after: '2' }] })).rejects.toThrow();
    expect(await readFile(path.join(project.path, 'src', 'app.js'), 'utf8')).toContain('value = 1');
  });

  it('ne déclare pas proven un dépôt déjà vert sans édition du moteur', async () => {
    await setup();
    const created = await mission();
    const driver = vi.fn(async () => idle('inutile'));
    const view = await runAgentMission(ctx, project, created.id, { command: 'node -e "process.exit(0)"', confirm: true }, { driver });
    expect(driver).not.toHaveBeenCalled();
    expect(view.verdict.complete).toBe(false);
    expect(view.verdict.label).toBe('IN_PROGRESS');
  });

  it('certification : modèle local absent, OpenCode non appelé, bug conservé', async () => {
    await setup();
    const profile = store.get<Profile>('profiles', 'fixture-profile');
    store.put('profiles', { ...profile!, baseUrl: 'http://127.0.0.1:9/v1' });
    const created = await mission();
    const view = await runAgentMission(ctx, project, created.id, { command: fail, confirm: true, maxAttempts: 3, budgetMs: 5_000 });
    expect(view.verdict).toMatchObject({ complete: false, label: 'BLOCKED' });
    expect(view.repairs?.at(-1)?.stopped).toBe('blocked');
    expect(view.repairs?.at(-1)?.diagnosis).toMatch(/injoignable|BLOCKED/);
    expect(view.repairs?.some((item) => item.invoked)).toBe(false);
    expect(await readFile(path.join(project.path, 'src', 'app.js'), 'utf8')).toBe('export const value = 1;\n');
    expect(ctx.createSession).not.toHaveBeenCalled();
    expect(ctx.prompt).not.toHaveBeenCalled();
  });
});
