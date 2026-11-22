import { spawn, type ChildProcess } from 'node:child_process';
import type { Express } from 'express';
import { z } from 'zod';
import type { Project } from '../../shared/contracts.js';
import { AdvancedError, type Context, all, confirmed, id, now, param, project, redact, route, trusted } from './common.js';
import { commandVerdict, certificationPlan, type CertStatus, type CommandProof } from './certification.js';
import { decideCommand, decidePath, dockerRunArgs, defaultPolicy, type ExecutionPolicy } from './execution-policy.js';
import { acquireLease, finishLease } from './resilience.js';
import { authorizeOperation } from './mission-integrity.js';
import { execute, safeEnvironment, type Execution } from './process.js';

export interface SecureRun {
  id: string;
  projectId: string;
  missionId: string;
  command: string;
  isolationRequested: 'required' | 'local';
  runtime: 'docker' | 'local' | 'none';
  isolation: 'container' | 'none' | 'unavailable';
  enforced: { memory: boolean; cpu: boolean; pids: boolean; network: boolean; readOnly: boolean; droppedCaps: boolean };
  verdict: CertStatus;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  cancelled: boolean;
  dockerRan: boolean;
  evidence: CommandProof['evidence'];
  simulated: false;
  output: string;
  decisions: { code: string; allowed: boolean; reason: string }[];
  leaseId?: string;
  createdAt: string;
}

const jobs = new Map<string, { kill: (reason: 'cancel' | 'timeout') => void }>();

export function cancelSecure(executionId: string): boolean {
  const job = jobs.get(executionId);
  if (!job) return false;
  job.kill('cancel');
  return true;
}

export async function probeDocker(run: typeof execute = execute): Promise<{ available: boolean; reason: string; evidence: 'live' | 'absent' }> {
  try {
    const info = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { cwd: '/tmp', timeoutMs: 4_000, maxOutput: 4_000 });
    if (info.exitCode !== 0 || info.timedOut || info.truncated || !info.output.trim()) return { available: false, reason: 'docker info indisponible', evidence: 'absent' };
    const image = await run('docker', ['image', 'inspect', 'node:22-alpine', '--format', '{{.Id}}'], { cwd: '/tmp', timeoutMs: 4_000, maxOutput: 4_000 });
    if (image.exitCode !== 0 || image.timedOut || !image.output.trim()) return { available: false, reason: 'Image node:22-alpine absente. Pas de pull automatique.', evidence: 'absent' };
    return { available: true, reason: 'docker et image locale disponibles', evidence: 'live' };
  } catch {
    return { available: false, reason: 'Docker absent. Aucun basculement vers le runtime local.', evidence: 'absent' };
  }
}

function spawnTracked(executionId: string, executable: string, args: string[], cwd: string, timeoutMs: number): Promise<Execution & { cancelled: boolean }> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(executable, args, { cwd, env: safeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    let cancelled = false;
    let timedOut = false;
    let truncated = false;
    let bytes = 0;
    const parts: Buffer[] = [];
    const kill = (reason: 'cancel' | 'timeout') => {
      if (reason === 'cancel') cancelled = true;
      if (reason === 'timeout') timedOut = true;
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    jobs.set(executionId, { kill });
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    const consume = (chunk: Buffer) => {
      if (bytes < 32_000) parts.push(chunk.subarray(0, 32_000 - bytes));
      bytes += chunk.length;
      if (bytes > 32_000) { truncated = true; kill('timeout'); }
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.once('error', (error) => { clearTimeout(timer); jobs.delete(executionId); reject(error); });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      jobs.delete(executionId);
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch { /* groupe déjà clos */ }
      resolve({ output: Buffer.concat(parts).toString('utf8'), exitCode, signal, timedOut, truncated, durationMs: Date.now() - start, cancelled });
    });
  });
}

const schema = z.object({
  confirm: z.literal(true),
  command: z.string().trim().min(1).max(500),
  isolation: z.enum(['required', 'local']),
  timeoutMs: z.number().int().min(50).max(120_000).optional(),
  memoryMb: z.number().int().min(64).max(2_048).optional(),
  cpus: z.number().min(0.1).max(2).optional(),
  maxProcesses: z.number().int().min(8).max(256).optional(),
  network: z.enum(['deny', 'allow']).optional(),
  taskKey: z.string().trim().min(1).max(200).optional(),
  invalidated: z.boolean().optional(),
}).strict();

function blank(target: Project, missionId: string, command: string, isolation: 'required' | 'local'): SecureRun {
  return {
    id: id(), projectId: target.id, missionId, command, isolationRequested: isolation, runtime: 'none', isolation: 'unavailable',
    enforced: { memory: false, cpu: false, pids: false, network: false, readOnly: false, droppedCaps: false },
    verdict: 'BLOCKED', exitCode: null, timedOut: false, truncated: false, cancelled: false, dockerRan: false, evidence: 'absent', simulated: false,
    output: '', decisions: [], createdAt: now(),
  };
}

export async function executeSecure(ctx: Context, target: Project, missionId: string, input: unknown, options: {
  probe?: () => Promise<{ available: boolean; reason: string }>;
  dockerRun?: (args: string[]) => Promise<Execution>;
  onStart?: (executionId: string) => void;
  clock?: () => number;
} = {}): Promise<SecureRun> {
  confirmed(input); trusted(target);
  const parsed = schema.parse(input);
  const policy: ExecutionPolicy = defaultPolicy({
    timeoutMs: parsed.timeoutMs ?? 15_000,
    memoryMb: parsed.memoryMb ?? 256,
    cpus: parsed.cpus ?? 1,
    maxProcesses: parsed.maxProcesses ?? 64,
    network: parsed.network ?? 'deny',
    isolation: parsed.isolation,
  });
  const record = blank(target, missionId, parsed.command, parsed.isolation);
  const commandDecision = decideCommand(policy, parsed.command);
  record.decisions.push(commandDecision);
  if (!commandDecision.allowed) {
    record.verdict = 'BLOCKED';
    record.output = commandDecision.reason;
    return ctx.store.put('executions', { ...record, output: redact(ctx, record.output) }, target.id);
  }
  for (const relative of parsed.command.trim().split(/\s+/).slice(1)) {
    if (relative.startsWith('-')) continue;
    const pathDecision = await decidePath(target.path, relative);
    record.decisions.push(pathDecision);
    if (!pathDecision.allowed) {
      record.verdict = 'BLOCKED';
      record.output = pathDecision.reason;
      return ctx.store.put('executions', record, target.id);
    }
  }
  const integrity = authorizeOperation(ctx, target, missionId, {
    source: 'agent', action: 'execute', repository: target.path,
    paths: parsed.command.trim().split(/\s+/).slice(1).filter((part) => !part.startsWith('-')),
  });
  if (!integrity.allowed) {
    record.verdict = 'BLOCKED';
    record.output = integrity.reason;
    record.decisions.push({ code: integrity.code, allowed: false, reason: integrity.reason });
    return ctx.store.put('executions', { ...record, output: redact(ctx, record.output) }, target.id);
  }
  const lease = acquireLease(ctx, { projectId: target.id, missionId, taskKey: parsed.taskKey ?? 'command', ttlMs: policy.timeoutMs + 2_000, invalidated: parsed.invalidated, idempotencyKey: `${target.id}:${missionId}:${parsed.taskKey ?? parsed.command}` }, options.clock);
  if (!lease.ok) {
    record.verdict = 'BLOCKED';
    record.output = lease.code === 'ALREADY_PASSED' ? 'Tâche déjà validée. Aucune relance sans invalidation.' : lease.code === 'EXTERNAL_UNCERTAIN' ? 'Effet externe incertain. Pas de seconde exécution et pas de garantie exactement une fois.' : 'Exécution déjà en cours ou retries épuisés.';
    record.decisions.push({ code: lease.code, allowed: false, reason: record.output });
    record.leaseId = lease.lease?.id;
    return ctx.store.put('executions', record, target.id);
  }
  record.leaseId = lease.lease.id;
  const evidence: CommandProof['evidence'] = options.probe || options.dockerRun ? 'test-double' : 'absent';
  try {
    if (parsed.isolation === 'required') {
      const probed = options.probe ? { ...(await options.probe()), evidence: 'test-double' as const } : await probeDocker();
      record.evidence = options.probe || options.dockerRun ? 'test-double' : probed.evidence;
      record.decisions.push({ code: probed.available ? 'DOCKER_READY' : 'BLOCKED_SANDBOX', allowed: probed.available, reason: probed.reason });
      if (!probed.available) {
        record.verdict = 'BLOCKED_SANDBOX';
        record.runtime = 'none';
        record.isolation = 'unavailable';
        record.output = probed.reason;
        finishLease(ctx, target.id, lease.lease.id, 'failed', options.clock);
        return ctx.store.put('executions', { ...record, output: redact(ctx, record.output) }, target.id);
      }
      if (record.evidence !== 'live' && !options.dockerRun) {
        record.verdict = 'BLOCKED_SANDBOX';
        record.output = 'Sonde non réelle. Aucun basculement local et aucun CERTIFIED.';
        finishLease(ctx, target.id, lease.lease.id, 'failed', options.clock);
        return ctx.store.put('executions', record, target.id);
      }
      if (record.evidence !== 'live') {
        record.decisions.push({ code: 'TEST_DOUBLE', allowed: true, reason: 'Adaptateur injecté. Le résultat ne peut pas être CERTIFIED.' });
      }
      const argv = parsed.command.split(/\s+/);
      const args = dockerRunArgs({ name: `cortex-exec-${record.id.replace(/[^a-z0-9-]/gi, '').slice(0, 48)}`, image: 'node:22-alpine', projectPath: target.path, command: argv, policy });
      const ran = await (options.dockerRun ?? ((dockerArgs: string[]) => execute('docker', dockerArgs, { cwd: target.path, timeoutMs: policy.timeoutMs + 2_000 })))(args);
      record.dockerRan = true;
      record.runtime = 'docker';
      record.isolation = 'container';
      record.enforced = { memory: true, cpu: true, pids: true, network: policy.network === 'deny', readOnly: true, droppedCaps: true };
      record.exitCode = ran.exitCode;
      record.timedOut = ran.timedOut;
      record.truncated = ran.truncated;
      record.output = redact(ctx, ran.output).slice(0, 4_000);
      record.verdict = commandVerdict({ isolationRequested: 'required', dockerRan: true, evidence: record.evidence, exitCode: ran.exitCode, timedOut: ran.timedOut, truncated: ran.truncated, denied: false, simulated: record.evidence !== 'live' });
      finishLease(ctx, target.id, lease.lease.id, record.verdict === 'CERTIFIED' || record.verdict === 'PASSED_LOCAL' ? 'passed' : 'failed', options.clock);
      return ctx.store.put('executions', record, target.id);
    }
    record.runtime = 'local';
    record.isolation = 'none';
    record.evidence = 'absent';
    record.decisions.push({ code: 'NETWORK_NOT_ENFORCED', allowed: true, reason: 'Runtime local explicitement non isolé. Le réseau, la mémoire et les capabilities ne sont pas confinés.' });
    const argv = parsed.command.split(/\s+/);
    const pending = spawnTracked(record.id, argv[0] ?? 'node', argv.slice(1), target.path, policy.timeoutMs);
    options.onStart?.(record.id);
    const ran = await pending;
    record.exitCode = ran.exitCode;
    record.timedOut = ran.timedOut;
    record.truncated = ran.truncated;
    record.cancelled = ran.cancelled;
    record.output = redact(ctx, ran.output).slice(0, 4_000);
    record.verdict = ran.cancelled ? 'FAILED' : commandVerdict({ isolationRequested: 'local', dockerRan: false, evidence: 'absent', exitCode: ran.exitCode, timedOut: ran.timedOut, truncated: ran.truncated, denied: false, simulated: false });
    finishLease(ctx, target.id, lease.lease.id, record.verdict === 'PASSED_LOCAL' ? 'passed' : 'failed', options.clock);
    return ctx.store.put('executions', record, target.id);
  } catch (error) {
    record.verdict = 'FAILED';
    record.output = redact(ctx, error instanceof Error ? error.message : 'Exécution interrompue.');
    try { finishLease(ctx, target.id, lease.lease.id, 'failed', options.clock); } catch { /* bail déjà enregistré */ }
    return ctx.store.put('executions', record, target.id);
  }
}

export function registerSecureRoutes(app: Express, ctx: Context): void {
  app.get('/api/projects/:id/execution', route(ctx, async (_req, res) => {
    const docker = await probeDocker();
    res.json({ docker, local: { available: true, isolation: 'none', certified: false }, note: 'Le runtime local n’est pas un sandbox. CERTIFIED exige une exécution Docker réelle.' });
  }));
  app.get('/api/projects/:id/executions', route(ctx, (req, res) => res.json(all<SecureRun>(ctx, 'executions', project(ctx, req).id))));
  app.get('/api/projects/:id/certifications', route(ctx, async (req, res) => {
    project(ctx, req);
    const docker = await probeDocker();
    res.json(certificationPlan({ node: true, python: true, react: false, next: false, android: false, docker: docker.available }));
  }));
  app.post('/api/projects/:id/missions/:missionId/execute', route(ctx, async (req, res) => {
    res.json(await executeSecure(ctx, project(ctx, req), param(req, 'missionId'), req.body));
  }));
  app.post('/api/projects/:id/missions/:missionId/execute/cancel', route(ctx, (req, res) => {
    trusted(project(ctx, req));
    confirmed(req.body);
    const body = z.object({ confirm: z.literal(true), executionId: z.string().uuid() }).strict().parse(req.body);
    const stopped = cancelSecure(body.executionId);
    if (!stopped) throw new AdvancedError(409, 'EXECUTION_ABSENT', 'Aucune exécution annulable.');
    res.json({ cancelled: true, executionId: body.executionId });
  }));
}
