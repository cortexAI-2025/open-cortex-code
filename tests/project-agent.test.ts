import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HistoryEvent, Profile, Project } from '../shared/contracts.js';
import { Store } from '../server/store.js';
import { Vault } from '../server/vault.js';
import type { Context } from '../server/advanced/common.js';
import { runAgentMission, type AgentTurn } from '../server/advanced/agent-mission.js';
import { preparePullRequest } from '../server/advanced/git-publish.js';
import { createMission, updateMissionClaims } from '../server/advanced/mission.js';
import { gitOk } from '../server/advanced/process.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; vi.restoreAllMocks(); });

const idle = (reason: string): AgentTurn => ({ blocked: false, invoked: true, permissionStop: false, reason, model: 'mock/simulated-not-opencode', sessionId: 'session-sim', decisions: [{ action: 'edit', resources: ['src/rate.js'], decision: 'once' }], });

describe('agent multifichier, rôles locaux, PR non publiée', () => {
  let ctx: Context;
  let project: Project;
  let store: Store;

  async function setup(): Promise<void> {
    root = await mkdtemp(path.join(os.tmpdir(), 'cortex-project-'));
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

  const command = 'node --test tests/invoice.test.js';

  async function mission(paths = ['src']) {
    const created = createMission(ctx, project, { title: 'Facture', goal: 'TVA 0.2 et libellé EUR', profileId: 'fixture-profile', confirm: true });
    updateMissionClaims(ctx, project, created.id, { claims: [{ agentId: 'agent', paths }], confirm: true });
    return created;
  }

  it('corrige deux fichiers puis prépare une PR sans appeler gh', async () => {
    await setup();
    const created = await mission();
    const driver = vi.fn(async () => {
      await writeFile(path.join(project.path, 'src', 'rate.js'), 'exports.vat = () => 0.2;\n');
      await writeFile(path.join(project.path, 'src', 'invoice.js'), 'exports.label = () => "EUR";\n');
      return idle('correctif simulé, deux fichiers');
    });
    const view = await runAgentMission(ctx, project, created.id, { command, confirm: true, maxAttempts: 3 }, { driver });
    expect(view.verdict).toMatchObject({ complete: true, label: 'PROVEN' });
    expect(view.repairs?.at(-1)?.applied.sort()).toEqual(['src/invoice.js', 'src/rate.js']);
    expect(view.summary).toContain('src/rate.js');
    expect(view.summary).toContain('src/invoice.js');
    expect(view.plan?.map((item) => item.role)).toEqual(['planner', 'coder', 'tester', 'reviewer', 'orchestrator']);
    expect(view.roles?.some((item) => item.role === 'coder')).toBe(true);
    expect(view.roles?.some((item) => item.role === 'tester')).toBe(true);
    expect(view.permissions?.[0]).toMatchObject({ decision: 'once', action: 'edit' });
    expect(ctx.createSession).not.toHaveBeenCalled();
    const again = vi.fn(async () => idle('ne doit pas repartir'));
    const second = await runAgentMission(ctx, project, created.id, { command, confirm: true }, { driver: again });
    expect(again).not.toHaveBeenCalled();
    expect(second.verdict.complete).toBe(true);
    const gh = vi.fn(async () => { throw new Error('gh ne doit pas être appelé'); });
    const plan = await preparePullRequest(ctx, project, { confirm: true, base: 'main' }, gh);
    expect(gh).not.toHaveBeenCalled();
    expect(plan).toMatchObject({ published: false, merged: false, remoteCertified: false, plan: { head: 'cortex/fixture', repo: null, argv: null } });
    expect(plan.plan.body).toContain('src/rate.js');
  });

  it('crée un test nouveau et refuse d’en modifier un qui existe', async () => {
    await setup();
    const created = await mission(['src', 'tests']);
    const tamper = await runAgentMission(ctx, project, created.id, { command, confirm: true, maxAttempts: 1, testPolicy: 'create' }, { driver: async () => {
      await writeFile(path.join(project.path, 'tests', 'invoice.test.js'), 'test.skip("vat", () => {});\n');
      return idle('tamper');
    } });
    expect(tamper.repairs?.at(-1)?.stopped).toBe('test-tamper');
    expect(await readFile(path.join(project.path, 'tests', 'invoice.test.js'), 'utf8')).toContain('assert.equal(vat(),0.2)');
    const createCommand = 'node -e \'const fs=require("fs"); const t=fs.readFileSync("tests/label.test.js","utf8"); if(!t.includes("EUR")) process.exit(1);\'';
    const createdView = await runAgentMission(ctx, project, created.id, { command: createCommand, confirm: true, testPolicy: 'create' }, { driver: async () => {
      await writeFile(path.join(project.path, 'tests', 'label.test.js'), 'test("label", () => { if (!"EUR") throw new Error("x"); });\n');
      return idle('nouveau test');
    } });
    expect(createdView.verdict.label).toBe('PROVEN');
    expect(createdView.repairs?.at(-1)?.applied).toEqual(['tests/label.test.js']);
  });

  it('refuse la boucle Agent sur main', async () => {
    await setup();
    await gitOk(project, ['switch', 'main']);
    const created = await mission();
    const driver = vi.fn(async () => idle('interdit'));
    await expect(runAgentMission(ctx, project, created.id, { command, confirm: true }, { driver })).rejects.toMatchObject({ code: 'PROTECTED_BRANCH' });
    expect(driver).not.toHaveBeenCalled();
    expect(await readFile(path.join(project.path, 'src', 'rate.js'), 'utf8')).toContain('() => 0');
  });
});
