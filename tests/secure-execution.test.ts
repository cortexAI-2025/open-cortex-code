import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HistoryEvent, Project } from '../shared/contracts.js';
import { Store } from '../server/store.js';
import { Vault } from '../server/vault.js';
import type { Context } from '../server/advanced/common.js';
import { decideCommand, decideGit, defaultPolicy, dockerRunArgs } from '../server/advanced/execution-policy.js';
import { commandVerdict, certificationPlan, projectVerdict } from '../server/advanced/certification.js';
import { executeSecure, cancelSecure } from '../server/advanced/secure-execution.js';
import { acquireLease, beginExternal, detectAbandoned, heartbeatLease, retryDelay } from '../server/advanced/resilience.js';
import { classifyProviderError, guardModelCall, leaveProvider, observeProviderFailure, recordModelUse } from '../server/advanced/provider-resilience.js';
import { openCodeAgentDriver } from '../server/advanced/agent-mission.js';
import type { Mission } from '../server/advanced/mission.js';

let root = '';
let store: Store | undefined;
afterEach(async () => { try { store?.close(); } catch { /* déjà fermé */ } store = undefined; if (root) await rm(root, { recursive: true, force: true }); root = ''; });

function ctxFor(project: Project, vault: Vault): Context {
  return {
    store: store as Store, vault, engine: { request: () => { throw new Error('pas de moteur'); } }, project: () => project,
    createSession: () => { throw new Error('session refusée'); }, prompt: () => { throw new Error('prompt refusé'); },
    history: (projectId: string, kind: string, title: string, detail: string) => {
      const event: HistoryEvent = { id: `${kind}-${Math.random()}`, projectId, kind, title, detail, createdAt: new Date().toISOString() };
      return store!.put('history', event, projectId);
    },
  } as unknown as Context;
}

async function setup() {
  root = await mkdtemp(path.join(os.tmpdir(), 'cortex-secure-'));
  const projectPath = path.join(root, 'repo');
  await mkdir(path.join(projectPath, 'tests'), { recursive: true });
  const project: Project = { id: 'project-secure', path: projectPath, name: 'Secure', trusted: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const vault = new Vault();
  vault.set('fixture-profile', 'fixture-secret-not-a-real-service-key');
  store = new Store(path.join(root, 'data', 'cortex.sqlite'));
  store.put('projects', project);
  await writeFile(path.join(projectPath, 'tests', 'ok.test.js'), 'const {test}=require("node:test"); const assert=require("node:assert/strict"); test("ok",()=>assert.equal(1+1,2));\n');
  await writeFile(path.join(projectPath, 'tests', 'env-check.test.js'), 'const {test}=require("node:test"); const assert=require("node:assert/strict"); test("env",()=>{ assert.equal(process.env.XAI_API_KEY, undefined); assert.equal(process.env.GH_TOKEN, undefined); assert.equal(process.env.GITHUB_TOKEN, undefined); });\n');
  await writeFile(path.join(projectPath, 'tests', 'hang.test.js'), 'const {test}=require("node:test"); test("hang",()=>new Promise((resolve)=>setTimeout(resolve, 30000)));\n');
  await writeFile(path.join(projectPath, 'test_tax.py'), 'import unittest\nclass T(unittest.TestCase):\n    def test_rate(self):\n        self.assertEqual(1, 2)\nif __name__ == "__main__":\n    unittest.main()\n');
  return { project, ctx: ctxFor(project, vault), vault };
}

describe('politique et classement', () => {
  it('refuse le shell, le push forcé, main, et ne certifie ni un mock ni un runtime local', () => {
    const policy = defaultPolicy();
    expect(decideCommand(policy, 'rm -rf /').code).toBe('COMMAND_DENIED');
    expect(decideCommand(policy, 'git push --force origin main').code).toBe('COMMAND_DENIED');
    expect(decideCommand(policy, 'bash -c "cat .env"').code).toBe('COMMAND_DENIED');
    expect(decideCommand(policy, 'node --test tests/ok.test.js').allowed).toBe(true);
    expect(decideGit(policy, 'push', 'main').code).toBe('PROTECTED_BRANCH');
    expect(decideGit(policy, 'push', 'cortex/demo', true).code).toBe('FORCE_PUSH_DENIED');
    expect(decideGit(defaultPolicy({ git: { allowCommit: true, allowPush: false, allowPullRequest: false } }), 'commit', 'cortex/demo').allowed).toBe(true);
    expect(decideGit(defaultPolicy({ git: { allowCommit: true, allowPush: false, allowPullRequest: false } }), 'push', 'cortex/demo').code).toBe('PUBLISH_PERMISSION');
    expect(decideGit(defaultPolicy({ git: { allowCommit: false, allowPush: true, allowPullRequest: false } }), 'pull-request', 'cortex/demo').code).toBe('PUBLISH_PERMISSION');
    const dockerArgs = dockerRunArgs({ name: 'cortex-exec-abcdefgh', image: 'node:22-alpine', projectPath: '/tmp/project', command: ['node', '--test', 'tests/ok.test.js'], policy: defaultPolicy({ memoryMb: 128, maxProcesses: 32, network: 'deny' }) });
    expect(dockerArgs).toContain('--network');
    expect(dockerArgs).toContain('none');
    expect(dockerArgs).toContain('--cap-drop');
    expect(dockerArgs).toContain('ALL');
    expect(dockerArgs).toContain('--read-only');
    expect(dockerArgs).toContain('--user');
    expect(dockerArgs).toContain('65534:65534');
    expect(dockerArgs).toContain('--memory');
    expect(dockerArgs).toContain('128m');
    expect(dockerArgs.join(' ')).not.toContain('docker.sock');
    expect(dockerArgs).not.toContain('--privileged');
    const openNet = dockerRunArgs({ name: 'cortex-exec-abcdefgh', image: 'node:22-alpine', projectPath: '/tmp/project', command: ['node'], policy: defaultPolicy({ network: 'allow' }) });
    expect(openNet).toContain('bridge');
    expect(openNet.join(' ')).not.toContain('docker.sock');
    expect(commandVerdict({ isolationRequested: 'required', dockerRan: true, evidence: 'live', exitCode: 0, timedOut: false, truncated: false, denied: false, simulated: false })).toBe('CERTIFIED');
    expect(commandVerdict({ isolationRequested: 'local', dockerRan: false, evidence: 'absent', exitCode: 0, timedOut: false, truncated: false, denied: false, simulated: false })).toBe('PASSED_LOCAL');
    expect(commandVerdict({ isolationRequested: 'required', dockerRan: false, evidence: 'absent', exitCode: 0, timedOut: false, truncated: false, denied: false, simulated: false })).toBe('BLOCKED_SANDBOX');
    expect(commandVerdict({ isolationRequested: 'required', dockerRan: true, evidence: 'test-double', exitCode: 0, timedOut: false, truncated: false, denied: false, simulated: true })).toBe('BLOCKED');
    expect(projectVerdict({ isolationRequested: 'local', dockerRan: false, evidence: 'absent', exitCode: 0, timedOut: false, truncated: false, denied: false, simulated: true, modelInvoked: true, testsWereRed: true, testFileUnchanged: true, modelCalls: 1 })).toBe('BLOCKED');
    const plan = certificationPlan({ node: true, python: true, react: false, next: false, android: false, docker: false });
    expect(plan.find((item) => item.id === 'android-gradle')?.status).toBe('BLOCKED');
    expect(plan.find((item) => item.id === 'react')?.status).toBe('SKIPPED');
    expect(plan.find((item) => item.id === 'next')?.status).toBe('SKIPPED');
    expect(plan.find((item) => item.id === 'python')?.status).toBe('SKIPPED');
    expect(plan.every((item) => item.certified === false || item.status === 'CERTIFIED')).toBe(true);
    expect(plan.some((item) => item.status === 'CERTIFIED')).toBe(false);
    expect(classifyProviderError(429, '')).toBe('rate-limit');
    expect(classifyProviderError(503, '')).toBe('server');
    expect(classifyProviderError(401, '')).toBe('auth');
    expect(retryDelay(1, 'rate-limit', 2, 400).retry).toBe(true);
    expect(retryDelay(2, 'auth', 2, 400).retry).toBe(false);
    expect(retryDelay(2, 'server', 2, 400).retry).toBe(false);
  });
});

describe('exécution sécurisée', () => {
  it('exécute en local sans prétendre isoler, bloque Docker absent, et n’appelle pas le runtime local à la place', async () => {
    const { project, ctx } = await setup();
    const local = await executeSecure(ctx, project, 'mission-local', { confirm: true, command: 'node --test tests/ok.test.js', isolation: 'local' });
    expect(local.verdict).toBe('PASSED_LOCAL');
    expect(local.isolation).toBe('none');
    expect(local.enforced.network).toBe(false);
    expect(local.enforced.memory).toBe(false);
    expect(local.verdict).not.toBe('CERTIFIED');
    const secrets = await executeSecure(ctx, project, 'mission-secrets', { confirm: true, command: 'node --test tests/env-check.test.js', isolation: 'local' });
    expect(secrets.verdict).toBe('PASSED_LOCAL');
    const sandbox = await executeSecure(ctx, project, 'mission-sandbox', { confirm: true, command: 'node --test tests/ok.test.js', isolation: 'required' });
    expect(sandbox.verdict).toBe('BLOCKED_SANDBOX');
    expect(sandbox.dockerRan).toBe(false);
    let called = false;
    const injected = await executeSecure(ctx, project, 'mission-inject', { confirm: true, command: 'node --test tests/ok.test.js', isolation: 'required' }, {
      probe: async () => ({ available: false, reason: 'absent' }),
      dockerRun: async () => { called = true; throw new Error('bascule interdite'); },
    });
    expect(injected.verdict).toBe('BLOCKED_SANDBOX');
    expect(called).toBe(false);
    const doubled = await executeSecure(ctx, project, 'mission-double', { confirm: true, command: 'node --test tests/ok.test.js', isolation: 'required' }, {
      probe: async () => ({ available: true, reason: 'injecté' }),
      dockerRun: async (args) => {
        expect(args).toContain('none');
        expect(args.join(' ')).not.toContain('docker.sock');
        expect(args).not.toContain('--privileged');
        return { output: 'ok', exitCode: 0, signal: null, timedOut: false, truncated: false, durationMs: 1 };
      },
    });
    expect(doubled.verdict).toBe('BLOCKED');
    expect(doubled.dockerRan).toBe(true);
    expect(doubled.evidence).toBe('test-double');
  });

  it('bloque les traversées, secrets, liens, commandes interdites, le timeout, l’annulation et la concurrence', async () => {
    const { project, ctx } = await setup();
    const forbidden = await executeSecure(ctx, project, 'mission-rm', { confirm: true, command: 'rm -rf /', isolation: 'local' });
    expect(forbidden.verdict).toBe('BLOCKED');
    expect(forbidden.decisions[0]?.code).toBe('COMMAND_DENIED');
    const traversal = await executeSecure(ctx, project, 'mission-dot', { confirm: true, command: 'node --test ../secret.test.js', isolation: 'local' });
    expect(traversal.verdict).toBe('BLOCKED');
    const secretFile = await executeSecure(ctx, project, 'mission-env', { confirm: true, command: 'node --test .env', isolation: 'local' });
    expect(secretFile.verdict).toBe('BLOCKED');
    expect(secretFile.decisions.some((item) => item.code === 'SENSITIVE_FILE')).toBe(true);
    await symlink('/etc/passwd', path.join(project.path, 'tests', 'outside.js'));
    const link = await executeSecure(ctx, project, 'mission-link', { confirm: true, command: 'node --test tests/outside.js', isolation: 'local' });
    expect(link.verdict).toBe('BLOCKED');
    expect(link.decisions.some((item) => item.code === 'SYMLINK_ESCAPE')).toBe(true);
    const timed = await executeSecure(ctx, project, 'mission-timeout', { confirm: true, command: 'node --test tests/hang.test.js', isolation: 'local', timeoutMs: 400 });
    expect(timed.verdict).toBe('FAILED');
    expect(timed.timedOut).toBe(true);
    let secondCode = '';
    const cancelled = executeSecure(ctx, project, 'mission-cancel', { confirm: true, command: 'node --test tests/hang.test.js', isolation: 'local', timeoutMs: 10_000 }, {
      onStart: (executionId) => {
        void executeSecure(ctx, project, 'mission-cancel', { confirm: true, command: 'node --test tests/ok.test.js', isolation: 'local' }).then((second) => {
          secondCode = second.decisions.at(-1)?.code ?? '';
          cancelSecure(executionId);
        });
      },
    });
    const stopped = await cancelled;
    expect(secondCode).toBe('EXECUTION_BUSY');
    expect(stopped.cancelled || stopped.verdict === 'FAILED').toBe(true);
  }, 20_000);

  it('reprend après abandon, ne relance pas une tâche validée, et ne promet pas exactement une fois', async () => {
    const { project, ctx } = await setup();
    const passed = await executeSecure(ctx, project, 'mission-once', { confirm: true, command: 'node --test tests/ok.test.js', isolation: 'local' });
    expect(passed.verdict).toBe('PASSED_LOCAL');
    const again = await executeSecure(ctx, project, 'mission-once', { confirm: true, command: 'node --test tests/ok.test.js', isolation: 'local' });
    expect(again.verdict).toBe('BLOCKED');
    expect(again.decisions.some((item) => item.code === 'ALREADY_PASSED')).toBe(true);
    const red = await executeSecure(ctx, project, 'mission-py', { confirm: true, command: 'python3 test_tax.py', isolation: 'local' });
    expect(red.verdict).toBe('FAILED');
    expect(red.exitCode).not.toBe(0);
    expect(red.verdict).not.toBe('CERTIFIED');
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const clock = () => nowMs;
    const lease = acquireLease(ctx, { projectId: project.id, missionId: 'mission-lease', taskKey: 'coder', ttlMs: 1_000 }, clock);
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    nowMs += 400;
    heartbeatLease(ctx, project.id, lease.lease.id, 1_000, clock);
    nowMs += 2_000;
    expect(detectAbandoned(ctx, project.id, clock)).toHaveLength(1);
    const filename = store!.filename;
    store!.close();
    store = new Store(filename);
    (ctx as { store: Store }).store = store;
    expect(detectAbandoned(ctx, project.id, clock)[0]?.status).toBe('abandoned');
    let effects = 0;
    const first = beginExternal(ctx, project.id, 'publish-1', () => { effects += 1; });
    const second = beginExternal(ctx, project.id, 'publish-1', () => { effects += 1; });
    expect(first.exactlyOnce).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(effects).toBe(1);
    const uncertain = beginExternal(ctx, project.id, 'publish-2', () => { throw new Error('panne après envoi possible'); });
    expect(uncertain.state).toBe('unknown');
    expect(uncertain.exactlyOnce).toBe(false);
    let retried = 0;
    beginExternal(ctx, project.id, 'publish-2', () => { retried += 1; });
    expect(retried).toBe(0);
  });
});

describe('fournisseur', () => {
  it('borne les appels, ouvre le circuit et refuse un changement de fournisseur', async () => {
    const { project, ctx } = await setup();
    store!.put('provider-budgets', {
      id: 'mission-budget', projectId: project.id, providerId: 'xai', maxLlmCalls: 1, tokenBudget: 100, callsUsed: 0, tokensUsed: 0,
      maxConcurrent: 1, allowProviderSwitch: false, decisions: [],
    }, project.id);
    const first = guardModelCall(ctx, 'mission-budget', 'xai');
    expect(first.allowed).toBe(true);
    const busy = guardModelCall(ctx, 'mission-budget', 'xai');
    expect(busy.code).toBe('PROVIDER_CONCURRENCY');
    leaveProvider('xai');
    recordModelUse(ctx, 'mission-budget', { input: 80, output: 30 });
    const spent = guardModelCall(ctx, 'mission-budget', 'xai');
    expect(spent.code).toBe('LLM_BUDGET');
    const switched = guardModelCall(ctx, 'mission-budget', 'other');
    expect(switched.code).toBe('PROVIDER_SWITCH_DENIED');
    store!.put('provider-budgets', { id: 'mission-switch', projectId: project.id, providerId: 'xai', maxLlmCalls: 2, tokenBudget: 500, callsUsed: 0, tokensUsed: 0, maxConcurrent: 2, allowProviderSwitch: true, decisions: [] }, project.id);
    leaveProvider('xai');
    expect(guardModelCall(ctx, 'mission-switch', 'other').allowed).toBe(true);
    leaveProvider('other');
    for (let index = 0; index < 3; index += 1) observeProviderFailure(ctx, 'xai', project.id, 503, 'ghp_abcdefghijklmnopqrstuv');
    store!.put('provider-budgets', { id: 'mission-circuit', projectId: project.id, providerId: 'xai', maxLlmCalls: 5, tokenBudget: 5000, callsUsed: 0, tokensUsed: 0, maxConcurrent: 2, allowProviderSwitch: false, decisions: [] }, project.id);
    expect(guardModelCall(ctx, 'mission-circuit', 'xai').code).toBe('CIRCUIT_OPEN');
    const raw = JSON.stringify(store!.all('circuits'));
    expect(raw.includes('ghp_')).toBe(false);
    const mission = { id: 'mission-budget', projectId: project.id, profileId: 'fixture-profile', title: 'Budget', goal: 'rien', claims: [{ agentId: 'a', paths: ['src'] }], status: 'active' } as Mission;
    store!.put('profiles', { id: 'fixture-profile', name: 'Local', providerId: 'xai', modelId: 'grok', hasSecret: true, createdAt: project.createdAt }, project.id);
    (ctx as unknown as { refreshSession: () => Promise<unknown> }).refreshSession = async () => ({ status: 'idle' });
    (ctx as unknown as { prompt: () => Promise<unknown> }).prompt = async () => { throw new Error('le budget aurait dû bloquer avant le prompt'); };
    const turn = await openCodeAgentDriver(ctx, project, { mission, diagnosis: 'échec', attempt: 1, deadline: Date.now() + 1000, clock: Date.now, cancelled: () => false, testPolicy: 'deny' });
    expect(turn.invoked).toBe(false);
    expect(turn.reason).toContain('Budget');
  });
});
