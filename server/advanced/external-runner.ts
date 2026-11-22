import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import { z } from 'zod';
import type { Project } from '../../shared/contracts.js';
import { Store } from '../store.js';
import { AdvancedError, type Context, confirmed, id, now, param, project, redact, route, trusted } from './common.js';
import { commandVerdict } from './certification.js';
import { decideCommand, decidePath, defaultPolicy, dockerRunArgs } from './execution-policy.js';
import { authorizeOperation } from './mission-integrity.js';
import { execute, safeEnvironment, type Execution } from './process.js';
import { probeDocker } from './secure-execution.js';

export const SANDBOX_PROTOCOL = 1 as const;
const MAX_BODY = 64_000;

export interface ResourceLimits {
  timeoutMs: number;
  memoryMb: number;
  cpus: number;
  maxProcesses: number;
  network: 'deny' | 'allow';
}
export interface JobEnvelope {
  protocol: typeof SANDBOX_PROTOCOL;
  jobId: string;
  missionId: string;
  projectId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  command: string;
  isolation: 'required' | 'local';
  limits: ResourceLimits;
  repository: string;
}
export interface RunnerJob {
  id: string;
  projectId: string;
  missionId: string;
  command: string;
  isolationRequested: 'required' | 'local';
  status: 'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'cancelled' | 'orphaned';
  verdict: 'CERTIFIED' | 'PASSED_LOCAL' | 'BLOCKED' | 'FAILED' | 'NOT_TESTED';
  isolation: 'container' | 'namespace' | 'none' | 'unavailable';
  dockerRan: boolean;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  output: string;
  exactlyOnce: false;
  duplicate: boolean;
  evidence?: ExecutionProof;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionProof {
  id: string;
  missionId: string;
  runnerId: string;
  gitCommit: string | null;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  log: { at: string; text: string }[];
  outputSha256: string;
  artifacts: { path: string; sha256: string }[];
  isolation: 'namespace' | 'container' | 'none' | 'unavailable';
  dockerRan: boolean;
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  signature: string;
}

export interface FinancialQuote { currency: string; amount: number; limit: number }

/** Aucun coût n’est inventé. Sans tarif, le plafond financier ne s’applique pas. */
export function financialDecision(quote: FinancialQuote | null): { allowed: boolean; reason: string } {
  if (!quote) return { allowed: true, reason: 'tarif indisponible. Aucun plafond financier appliqué.' };
  if (!Number.isFinite(quote.amount) || !Number.isFinite(quote.limit) || quote.amount < 0 || quote.limit < 0) {
    return { allowed: false, reason: 'Tarif illisible. Aucune exécution.' };
  }
  if (quote.amount > quote.limit) return { allowed: false, reason: 'Budget financier dépassé.' };
  return { allowed: true, reason: 'Sous le plafond financier connu.' };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function signBody(body: unknown, secret: string): string {
  return createHmac('sha256', secret).update(canonical(body)).digest('hex');
}

export function signEnvelope(envelope: JobEnvelope, secret: string): string {
  return signBody(envelope, secret);
}

export function signaturesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const RUNNER_ID = 'cortex-loopback';

export function buildProof(input: Omit<ExecutionProof, 'outputSha256' | 'signature' | 'artifacts'> & { artifacts?: ExecutionProof['artifacts'] }, secret: string): ExecutionProof {
  const logText = input.log.map((line) => line.text).join('');
  const outputSha256 = createHash('sha256').update(logText).digest('hex');
  const body = { ...input, artifacts: input.artifacts ?? [{ path: 'stdout', sha256: outputSha256 }], outputSha256 };
  const { signature: _ignored, ...unsigned } = { ...body, signature: '' };
  return { ...unsigned, signature: signBody(unsigned, secret) };
}

export function verifyProof(proof: ExecutionProof, secret: string): { ok: boolean; reason: string } {
  const { signature, ...unsigned } = proof;
  if (!signature || !signaturesMatch(signature, signBody(unsigned, secret))) return { ok: false, reason: 'Preuve non authentifiée.' };
  const hash = createHash('sha256').update(proof.log.map((line) => line.text).join('')).digest('hex');
  if (hash !== proof.outputSha256) return { ok: false, reason: 'Empreinte de journal incohérente.' };
  if (proof.status === 'PASS' && (proof.exitCode !== 0 || proof.timedOut || proof.cancelled)) return { ok: false, reason: 'PASS incohérent avec le code de sortie.' };
  if (proof.status === 'PASS' && proof.isolation !== 'namespace' && proof.isolation !== 'container') return { ok: false, reason: 'PASS refusé sans isolation réelle.' };
  if (proof.status === 'PASS' && proof.isolation === 'container' && !proof.dockerRan) return { ok: false, reason: 'Conteneur déclaré sans exécution Docker.' };
  return { ok: true, reason: 'Preuve vérifiée.' };
}

export function acceptRunnerPayload(payload: RunnerJob, secret: string): { ok: boolean; reason: string } {
  if (payload.verdict === 'CERTIFIED' && payload.dockerRan !== true) return { ok: false, reason: 'CERTIFIED sans exécution Docker.' };
  if (payload.evidence?.status === 'PASS' && payload.evidence.isolation !== 'namespace' && !(payload.evidence.isolation === 'container' && payload.evidence.dockerRan)) {
    return { ok: false, reason: 'PASS refusé sans isolation réelle.' };
  }
  if (payload.status === 'running' || payload.status === 'queued') return { ok: true, reason: 'Job non terminal.' };
  const success = payload.status === 'passed' || payload.verdict === 'CERTIFIED' || payload.verdict === 'PASSED_LOCAL';
  if (!payload.evidence) return success ? { ok: false, reason: 'Résultat sans preuve signée.' } : { ok: true, reason: 'Aucun succès déclaré.' };
  const proof = verifyProof(payload.evidence, secret);
  if (!proof.ok) return proof;
  if (payload.evidence.id !== payload.id || payload.evidence.missionId !== payload.missionId || payload.evidence.command !== payload.command) {
    return { ok: false, reason: 'La preuve ne correspond pas au job.' };
  }
  if (payload.evidence.exitCode !== payload.exitCode || payload.evidence.dockerRan !== payload.dockerRan || payload.evidence.timedOut !== payload.timedOut || payload.evidence.cancelled !== payload.cancelled) {
    return { ok: false, reason: 'La preuve contredit le job.' };
  }
  if ((payload.isolation === 'namespace' || payload.isolation === 'container' || payload.isolation === 'none') && payload.evidence.isolation !== payload.isolation) {
    return { ok: false, reason: 'Isolement de la preuve contradictoire.' };
  }
  if (payload.isolation === 'namespace' && payload.status === 'passed' && payload.evidence.status !== 'PASS') return { ok: false, reason: 'Succès namespace sans PASS.' };
  if (payload.verdict === 'CERTIFIED' && (payload.evidence.status !== 'PASS' || payload.evidence.dockerRan !== true)) return { ok: false, reason: 'CERTIFIED incohérent.' };
  return { ok: true, reason: proof.reason };
}

let namespaceCache: { at: number; available: boolean; reason: string } | undefined;

export async function probeNamespace(): Promise<{ available: boolean; reason: string }> {
  if (namespaceCache && Date.now() - namespaceCache.at < 30_000) return namespaceCache;
  try {
    const ran = await execute('unshare', ['--user', '--map-root-user', '--net', '--mount', '--pid', '--fork', '--mount-proc', 'true'], { cwd: os.tmpdir(), timeoutMs: 4_000, env: safeEnvironment() });
    const available = ran.exitCode === 0 && !ran.timedOut && !ran.truncated;
    namespaceCache = { at: Date.now(), available, reason: available ? 'Namespaces utilisateur, réseau, montage et PID disponibles. Ce n’est pas Docker.' : 'unshare n’a pas isolé le processus.' };
  } catch {
    namespaceCache = { at: Date.now(), available: false, reason: 'unshare absent.' };
  }
  return namespaceCache;
}

async function releaseJail(jail: string): Promise<void> {
  for (const name of ['proc', 'tmp', 'work', 'lib64', 'lib', 'bin', 'usr']) {
    await execute('umount', ['-l', path.join(jail, name)], { cwd: os.tmpdir(), timeoutMs: 2_000, env: safeEnvironment() }).catch(() => undefined);
  }
  await rm(jail, { recursive: true, force: true }).catch(() => undefined);
}

function jailScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, '../runner/jail.sh'), path.join(here, '../../../server/runner/jail.sh')]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Script d’isolement introuvable.');
}

function spawnNamespace(jobId: string, command: string[], cwd: string, timeoutMs: number, network: 'deny' | 'allow', maxProcesses: number): Promise<Execution & { cancelled: boolean }> {
  const jail = path.join(os.tmpdir(), `cortex-jail-${jobId}`);
  const args = ['--user', '--map-root-user', ...(network === 'deny' ? ['--net'] : []), '--mount', '--pid', '--fork', '--propagation', 'private', '--', 'bash', jailScript(), jail, cwd, String(maxProcesses), ...command];
  return spawnLocal(jobId, 'unshare', args, cwd, timeoutMs).finally(() => releaseJail(jail));
}

const envelopeSchema = z.object({
  protocol: z.literal(SANDBOX_PROTOCOL),
  jobId: z.string().uuid(),
  missionId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
  nonce: z.string().min(16).max(200),
  issuedAt: z.string().min(10).max(40),
  expiresAt: z.string().min(10).max(40),
  command: z.string().min(1).max(500),
  isolation: z.enum(['required', 'local']),
  limits: z.object({
    timeoutMs: z.number().int().min(50).max(120_000),
    memoryMb: z.number().int().min(64).max(2_048),
    cpus: z.number().min(0.1).max(2),
    maxProcesses: z.number().int().min(8).max(256),
    network: z.enum(['deny', 'allow']),
  }).strict(),
  repository: z.string().min(1).max(4_096),
}).strict();

const cancelSchema = z.object({
  protocol: z.literal(SANDBOX_PROTOCOL),
  jobId: z.string().uuid(),
  nonce: z.string().min(16).max(200),
  issuedAt: z.string().min(10).max(40),
  expiresAt: z.string().min(10).max(40),
  action: z.literal('cancel'),
}).strict();

export function verifySigned(body: unknown, signature: string, secret: string, nowMs: number, replayed: boolean): { ok: true } | { ok: false; code: string; reason: string } {
  if (!signature || !secret) return { ok: false, code: 'AUTH_REQUIRED', reason: 'Signature absente.' };
  const asJob = envelopeSchema.safeParse(body);
  const asCancel = cancelSchema.safeParse(body);
  const data = asJob.success ? asJob.data : asCancel.success ? asCancel.data : null;
  if (!data) return { ok: false, code: 'PROTOCOL', reason: 'Protocole refusé.' };
  const expected = createHmac('sha256', secret).update(canonical(data)).digest('hex');
  if (!signaturesMatch(signature, expected)) return { ok: false, code: 'AUTH_REJECTED', reason: 'Signature invalide.' };
  const issued = Date.parse(data.issuedAt);
  const expires = Date.parse(data.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || issued > nowMs + 30_000 || expires < nowMs) {
    return { ok: false, code: 'REQUEST_EXPIRED', reason: 'Demande expirée ou horodatage refusé.' };
  }
  if (replayed) return { ok: false, code: 'REPLAY_REJECTED', reason: 'Nonce déjà utilisé.' };
  return { ok: true };
}

function scrub(secret: string, text: string): string {
  return text.split(secret).join('[REDACTED]').replace(/\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_]+/g, '[REDACTED]');
}

const running = new Map<string, { kill: () => void }>();

function publicJob(job: RunnerJob, secret: string): RunnerJob {
  return { ...job, output: scrub(secret, job.output).slice(0, 4_000) };
}

function spawnLocal(jobId: string, executable: string, args: string[], cwd: string, timeoutMs: number): Promise<Execution & { cancelled: boolean }> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: safeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let cancelled = false;
    let timedOut = false;
    let bytes = 0;
    const parts: Buffer[] = [];
    const kill = (reason: 'cancel' | 'timeout') => {
      if (reason === 'cancel') cancelled = true;
      if (reason === 'timeout') timedOut = true;
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    running.set(jobId, { kill: () => kill('cancel') });
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    const consume = (chunk: Buffer) => { if (bytes < 32_000) parts.push(chunk.subarray(0, 32_000 - bytes)); bytes += chunk.length; };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.once('error', (error) => { clearTimeout(timer); running.delete(jobId); reject(error); });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      running.delete(jobId);
      resolve({ output: Buffer.concat(parts).toString('utf8'), exitCode, signal, timedOut, truncated: bytes > 32_000, durationMs: Date.now() - start, cancelled });
    });
  });
}

async function runJob(store: Store, secret: string, job: RunnerJob, envelope: JobEnvelope): Promise<RunnerJob> {
  const policy = defaultPolicy({
    timeoutMs: envelope.limits.timeoutMs,
    memoryMb: envelope.limits.memoryMb,
    cpus: envelope.limits.cpus,
    maxProcesses: envelope.limits.maxProcesses,
    network: envelope.limits.network,
    isolation: envelope.isolation,
  });
  const commandDecision = decideCommand(policy, envelope.command);
  if (!commandDecision.allowed) return blockJob(store, secret, job, commandDecision.reason);
  const parts = envelope.command.trim().split(/\s+/).slice(1).filter((part) => !part.startsWith('-'));
  for (const relative of parts) {
    const pathDecision = await decidePath(envelope.repository, relative);
    if (!pathDecision.allowed) return blockJob(store, secret, job, pathDecision.reason);
  }
  if (envelope.isolation === 'required') {
    const docker = await probeDocker();
    if (docker.available && docker.evidence === 'live') {
      const name = `cortex-exec-${job.id.replace(/[^a-z0-9]/g, '').slice(0, 24)}`;
      const args = dockerRunArgs({ name, image: 'node:22-alpine', projectPath: envelope.repository, command: envelope.command.split(/\s+/), policy });
      const ran = await execute('docker', args, { cwd: envelope.repository, timeoutMs: policy.timeoutMs + 2_000, env: safeEnvironment() });
      return finish(store, secret, job, ran, true, 'container', envelope.repository);
    }
    const namespace = await probeNamespace();
    if (!namespace.available) return blockJob(store, secret, job, `${docker.reason} ${namespace.reason} Aucun basculement vers le processus local.`);
    const argv = envelope.command.split(/\s+/);
    const ran = await spawnNamespace(job.id, argv, envelope.repository, policy.timeoutMs, policy.network, policy.maxProcesses);
    const current = store.get<RunnerJob>('sandbox-jobs', job.id);
    if (current?.status === 'cancelled' || ran.cancelled) {
      job.status = 'cancelled';
      job.cancelled = true;
      job.verdict = 'FAILED';
      job.isolation = 'namespace';
      job.dockerRan = false;
      job.timedOut = ran.timedOut;
      job.output = scrub(secret, ran.output);
      job.evidence = proofFrom(secret, job, ran.output, null, 'FAIL');
      job.updatedAt = now();
      return store.put('sandbox-jobs', publicJob(job, secret), job.projectId);
    }
    return finish(store, secret, job, ran, false, 'namespace', envelope.repository);
  }
  job.isolation = 'none';
  const argv = envelope.command.split(/\s+/);
  const ran = await spawnLocal(job.id, argv[0] ?? 'node', argv.slice(1), envelope.repository, policy.timeoutMs);
  const current = store.get<RunnerJob>('sandbox-jobs', job.id);
  if (current?.status === 'cancelled' || ran.cancelled) {
    job.status = 'cancelled';
    job.cancelled = true;
    job.verdict = 'FAILED';
    job.timedOut = ran.timedOut;
    job.output = scrub(secret, ran.output);
    job.evidence = proofFrom(secret, job, ran.output, null, 'FAIL');
    job.updatedAt = now();
    return store.put('sandbox-jobs', publicJob(job, secret), job.projectId);
  }
  return finish(store, secret, job, ran, false, 'none', envelope.repository);
}

function blockJob(store: Store, secret: string, job: RunnerJob, output: string): RunnerJob {
  job.dockerRan = false;
  job.isolation = 'unavailable';
  job.status = 'blocked';
  job.verdict = 'BLOCKED';
  job.exitCode = null;
  job.output = scrub(secret, output);
  job.evidence = proofFrom(secret, job, job.output, null, 'BLOCKED');
  job.updatedAt = now();
  return store.put('sandbox-jobs', publicJob(job, secret), job.projectId);
}

async function gitHead(repository: string): Promise<string | null> {
  const ran = await execute('git', ['-C', repository, 'rev-parse', 'HEAD'], { cwd: repository, timeoutMs: 2_000, env: safeEnvironment() }).catch(() => undefined);
  const value = ran && ran.exitCode === 0 ? ran.output.trim() : '';
  return /^[0-9a-f]{40}$/.test(value) ? value : null;
}

function proofFrom(secret: string, job: RunnerJob, output: string, gitCommit: string | null, status: ExecutionProof['status']): ExecutionProof {
  return buildProof({
    id: job.id, missionId: job.missionId, runnerId: RUNNER_ID, gitCommit, command: job.command, exitCode: job.exitCode,
    timedOut: job.timedOut, cancelled: job.cancelled, log: [{ at: now(), text: scrub(secret, output) }],
    isolation: job.isolation === 'container' || job.isolation === 'namespace' || job.isolation === 'none' ? job.isolation : 'unavailable', dockerRan: job.dockerRan, status,
  }, secret);
}

async function finish(store: Store, secret: string, job: RunnerJob, ran: Execution, dockerRan: boolean, runtime: 'container' | 'namespace' | 'none', repository: string): Promise<RunnerJob> {
  const current = store.get<RunnerJob>('sandbox-jobs', job.id);
  if (current?.status === 'cancelled') return current;
  job.dockerRan = dockerRan;
  job.isolation = runtime === 'none' ? 'none' : runtime;
  job.exitCode = ran.exitCode;
  job.timedOut = ran.timedOut;
  job.output = scrub(secret, ran.output);
  job.updatedAt = now();
  if (runtime === 'container' && dockerRan) {
    const status = commandVerdict({
      isolationRequested: 'required', dockerRan: true, evidence: 'live',
      exitCode: ran.exitCode, timedOut: ran.timedOut, truncated: ran.truncated, denied: false, simulated: false,
    });
    job.verdict = status === 'CERTIFIED' ? 'CERTIFIED' : 'FAILED';
  } else if (runtime === 'namespace') {
    job.verdict = ran.exitCode === 0 && !ran.timedOut && !ran.truncated ? 'PASSED_LOCAL' : 'FAILED';
  } else {
    const status = commandVerdict({
      isolationRequested: 'local', dockerRan: false, evidence: 'absent',
      exitCode: ran.exitCode, timedOut: ran.timedOut, truncated: ran.truncated, denied: false, simulated: false,
    });
    job.verdict = status === 'PASSED_LOCAL' ? 'PASSED_LOCAL' : 'FAILED';
  }
  if (job.verdict === 'CERTIFIED' && !dockerRan) job.verdict = 'BLOCKED';
  job.status = job.verdict === 'PASSED_LOCAL' || job.verdict === 'CERTIFIED' ? 'passed' : 'failed';
  const proofStatus: ExecutionProof['status'] = (runtime === 'namespace' && job.verdict === 'PASSED_LOCAL') || job.verdict === 'CERTIFIED'
    ? 'PASS'
    : job.verdict === 'FAILED' ? 'FAIL' : 'BLOCKED';
  job.evidence = buildProof({
    id: job.id, missionId: job.missionId, runnerId: RUNNER_ID, gitCommit: await gitHead(repository), command: job.command, exitCode: job.exitCode,
    timedOut: job.timedOut, cancelled: false, log: [{ at: job.updatedAt, text: job.output }],
    isolation: runtime === 'none' ? 'none' : runtime, dockerRan, status: proofStatus,
  }, secret);
  return store.put('sandbox-jobs', publicJob(job, secret), job.projectId);
}

export function recoverOrphans(store: Store): RunnerJob[] {
  return store.all<RunnerJob>('sandbox-jobs').map((job) => {
    if (job.status !== 'running' && job.status !== 'queued') return job;
    job.status = 'orphaned';
    job.verdict = 'FAILED';
    job.output = 'Job orphelin après arrêt du runner. Pas de seconde exécution automatique.';
    job.exactlyOnce = false;
    job.updatedAt = now();
    return store.put('sandbox-jobs', job, job.projectId);
  }).filter((job) => job.status === 'orphaned');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('corps trop grand')); req.destroy(); return; }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

export function startRunner(options: { secret: string; dataDir: string; host?: string; port?: number }): Promise<{ port: number; url: string; close: () => Promise<void> }> {
  if (options.secret.length < 16) throw new Error('Jeton runner trop court.');
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') throw new Error('Bind non loopback refusé.');
  const store = new Store(`${options.dataDir}/runner.sqlite`);
  recoverOrphans(store);
  const server: Server = createServer((req, res) => { void onRequest(store, options.secret, req, res); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port, url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => { for (const job of running.values()) job.kill(); server.close(() => { store.close(); done(); }); }),
      });
    });
  });
}

async function onRequest(store: Store, secret: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.url === '/v1/health' && req.method === 'GET') {
      const docker = await probeDocker();
      const namespace = await probeNamespace();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ protocol: SANDBOX_PROTOCOL, ok: true, docker: docker.available, namespace: namespace.available, evidence: docker.evidence, bind: 'loopback', certified: false, runnerId: RUNNER_ID }));
      return;
    }
    const signature = String(req.headers['x-cortex-signature'] ?? '');
    const raw = req.method === 'GET' ? '' : await readBody(req);
    if (req.method === 'GET' && req.url?.startsWith('/v1/jobs/')) {
      if (!signaturesMatch(signature, createHmac('sha256', secret).update(req.url).digest('hex'))) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Signature invalide.', code: 'AUTH_REJECTED' }));
        return;
      }
      const jobId = req.url.split('/').pop() ?? '';
      const job = store.get<RunnerJob>('sandbox-jobs', jobId);
      if (!job) { res.writeHead(404).end(JSON.stringify({ error: 'Job inconnu.' })); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(publicJob(job, secret)));
      return;
    }
    const body = raw ? JSON.parse(raw) as unknown : {};
    const replayed = Boolean(body && typeof body === 'object' && 'nonce' in body && store.get('sandbox-nonces', String((body as { nonce: string }).nonce)));
    const verdict = verifySigned(body, signature, secret, Date.now(), replayed);
    if (!verdict.ok) {
      res.writeHead(verdict.code === 'AUTH_REJECTED' || verdict.code === 'AUTH_REQUIRED' || verdict.code === 'REQUEST_EXPIRED' || verdict.code === 'REPLAY_REJECTED' ? 401 : 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: verdict.reason, code: verdict.code }));
      return;
    }
    const nonce = String((body as { nonce: string }).nonce);
    store.put('sandbox-nonces', { id: nonce, projectId: 'runner', at: now() });
    if (req.method === 'POST' && req.url === '/v1/jobs') {
      const envelope = envelopeSchema.parse(body);
      const existing = store.get<RunnerJob>('sandbox-jobs', envelope.jobId);
      if (existing) {
        existing.duplicate = true;
        existing.exactlyOnce = false;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(publicJob(existing, secret)));
        return;
      }
      const job: RunnerJob = {
        id: envelope.jobId, projectId: envelope.projectId, missionId: envelope.missionId, command: envelope.command,
        isolationRequested: envelope.isolation, status: 'running', verdict: 'NOT_TESTED', isolation: 'unavailable', dockerRan: false,
        exitCode: null, timedOut: false, cancelled: false, output: '', exactlyOnce: false, duplicate: false, createdAt: now(), updatedAt: now(),
      };
      store.put('sandbox-jobs', job, job.projectId);
      if (envelope.isolation === 'local') {
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify(publicJob(job, secret)));
        void runJob(store, secret, job, envelope).catch((error: unknown) => {
          const current = store.get<RunnerJob>('sandbox-jobs', job.id);
          if (!current || current.status === 'cancelled' || current.status === 'passed') return;
          current.status = 'failed';
          current.verdict = 'FAILED';
          current.output = scrub(secret, error instanceof Error ? error.message : 'Job interrompu.');
          current.updatedAt = now();
          store.put('sandbox-jobs', current, current.projectId);
        });
        return;
      }
      try {
        const finished = await runJob(store, secret, job, envelope);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(finished));
      } catch (error) {
        const current = store.get<RunnerJob>('sandbox-jobs', job.id) ?? job;
        if (current.status === 'running' || current.status === 'queued') {
          current.status = 'failed';
          current.verdict = 'FAILED';
          current.output = scrub(secret, error instanceof Error ? error.message : 'Job interrompu.');
          current.updatedAt = now();
          store.put('sandbox-jobs', current, current.projectId);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(publicJob(current, secret)));
      }
      return;
    }
    if (req.method === 'POST' && req.url?.endsWith('/cancel')) {
      const cancel = cancelSchema.parse(body);
      const job = store.get<RunnerJob>('sandbox-jobs', cancel.jobId);
      if (!job) { res.writeHead(404).end(JSON.stringify({ error: 'Job inconnu.' })); return; }
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'cancelled';
        job.cancelled = true;
        job.verdict = 'FAILED';
        job.updatedAt = now();
        running.get(job.id)?.kill();
        store.put('sandbox-jobs', job, job.projectId);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(publicJob(job, secret)));
      return;
    }
    res.writeHead(404).end(JSON.stringify({ error: 'Route inconnue.' }));
  } catch (error) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message.split(secret).join('[REDACTED]') : 'Requête refusée.' }));
  }
}

export function runnerRequest(url: string, method: string, secret: string, body?: unknown, getPath?: string): { path: string; signature: string; payload?: string } {
  if (getPath) return { path: getPath, signature: createHmac('sha256', secret).update(getPath).digest('hex') };
  const payload = JSON.stringify(body);
  const signature = createHmac('sha256', secret).update(canonical(body)).digest('hex');
  return { path: url, signature, payload };
}

function loopbackUrl(value: string): URL {
  const url = new URL(value);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (url.protocol === 'http:' && !loopback) throw new AdvancedError(400, 'RUNNER_URL_DENIED', 'Un runner HTTP public est refusé.');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AdvancedError(400, 'RUNNER_URL_DENIED', 'Protocole runner refusé.');
  return url;
}

export async function dispatchSandbox(ctx: Context, target: Project, missionId: string, input: unknown, deps: { fetchImpl?: typeof fetch; runnerUrl: string; secret: string; nowMs?: number } ): Promise<RunnerJob> {
  confirmed(input); trusted(target);
  const parsed = z.object({
    confirm: z.literal(true),
    command: z.string().trim().min(1).max(500),
    isolation: z.enum(['required', 'local']),
    quote: z.object({ currency: z.string().min(1).max(8), amount: z.number(), limit: z.number() }).strict().nullable().optional(),
  }).strict().parse(input);
  const money = financialDecision(parsed.quote ?? null);
  if (!money.allowed) {
    const denied: RunnerJob = blankJob(target.id, missionId, parsed.command, parsed.isolation, 'BLOCKED', money.reason);
    return ctx.store.put('sandbox-jobs', denied, target.id);
  }
  const gate = authorizeOperation(ctx, target, missionId, { source: 'agent', action: 'execute', repository: target.path });
  if (!gate.allowed) {
    const denied = blankJob(target.id, missionId, parsed.command, parsed.isolation, 'BLOCKED', gate.reason);
    return ctx.store.put('sandbox-jobs', denied, target.id);
  }
  const endpoint = loopbackUrl(deps.runnerUrl);
  const envelope: JobEnvelope = {
    protocol: SANDBOX_PROTOCOL, jobId: randomUUID(), missionId, projectId: target.id, nonce: randomUUID(),
    issuedAt: new Date(deps.nowMs ?? Date.now()).toISOString(), expiresAt: new Date((deps.nowMs ?? Date.now()) + 60_000).toISOString(),
    command: parsed.command, isolation: parsed.isolation,
    limits: { timeoutMs: 15_000, memoryMb: 256, cpus: 1, maxProcesses: 64, network: 'deny' },
    repository: target.path,
  };
  const signed = runnerRequest(endpoint.origin, 'POST', deps.secret, envelope);
  try {
    const response = await (deps.fetchImpl ?? fetch)(`${endpoint.origin}/v1/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cortex-signature': signed.signature }, body: signed.payload });
    let payload = await response.json() as RunnerJob;
    const reject = (reason: string) => ctx.store.put('sandbox-jobs', blankJob(target.id, missionId, parsed.command, parsed.isolation, 'BLOCKED', reason), target.id);
    if (!response.ok) return reject('Réponse runner refusée.');
    const first = acceptRunnerPayload(payload, deps.secret);
    if (!first.ok) return reject(first.reason);
    const deadline = Date.now() + envelope.limits.timeoutMs + 2_000;
    while (payload.status === 'running' || payload.status === 'queued') {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
      const getPath = `/v1/jobs/${payload.id}`;
      const get = runnerRequest(endpoint.origin, 'GET', deps.secret, undefined, getPath);
      const next = await (deps.fetchImpl ?? fetch)(`${endpoint.origin}${getPath}`, { headers: { 'x-cortex-signature': get.signature } });
      if (next.ok) payload = await next.json() as RunnerJob;
      else break;
    }
    const last = acceptRunnerPayload(payload, deps.secret);
    if (!last.ok) return reject(last.reason);
    payload.exactlyOnce = false;
    if (payload.verdict === 'CERTIFIED' && payload.dockerRan !== true) payload.verdict = 'BLOCKED';
    return ctx.store.put('sandbox-jobs', payload, target.id);
  } catch {
    const denied = blankJob(target.id, missionId, parsed.command, parsed.isolation, 'BLOCKED', 'Runner injoignable. Aucun CERTIFIED.');
    return ctx.store.put('sandbox-jobs', denied, target.id);
  }
}

function blankJob(projectId: string, missionId: string, command: string, isolation: 'required' | 'local', verdict: RunnerJob['verdict'], output: string): RunnerJob {
  return {
    id: id(), projectId, missionId, command, isolationRequested: isolation, status: 'blocked', verdict, isolation: 'unavailable', dockerRan: false,
    exitCode: null, timedOut: false, cancelled: false, output, exactlyOnce: false, duplicate: false, createdAt: now(), updatedAt: now(),
  };
}

export function registerSandboxRoutes(app: Express, ctx: Context): void {
  app.get('/api/projects/:id/sandbox', route(ctx, async (req, res) => {
    const target = project(ctx, req);
    const runnerUrl = process.env.CORTEX_RUNNER_URL || 'http://127.0.0.1:8791';
    let reachable = false;
    let docker = false;
    let namespace = false;
    let runnerId = 'inconnu';
    try {
      const health = await fetch(`${loopbackUrl(runnerUrl).origin}/v1/health`);
      if (health.ok) {
        const body = await health.json() as { docker?: boolean; namespace?: boolean; runnerId?: string };
        reachable = true;
        docker = body.docker === true;
        namespace = body.namespace === true;
        runnerId = body.runnerId || runnerId;
      }
    } catch { reachable = false; }
    const note = !reachable
      ? 'Runner absent. Statut BLOCKED, pas CERTIFIED.'
      : docker
        ? 'Runner joint. CERTIFIED exige encore une exécution Docker réelle.'
        : namespace
          ? 'Runner joint. Namespace disponible. Ce n’est pas Docker et ce n’est pas CERTIFIED.'
          : 'Runner joint. Aucune isolation disponible. Pas de bascule locale silencieuse.';
    res.json({
      protocol: SANDBOX_PROTOCOL, runnerUrl, reachable, docker, namespace, runnerId, location: 'loopback', certified: false,
      jobs: ctx.store.all<RunnerJob>('sandbox-jobs', target.id),
      note,
    });
  }));
  app.post('/api/projects/:id/missions/:missionId/sandbox', route(ctx, async (req, res) => {
    const secret = process.env.CORTEX_RUNNER_TOKEN || '';
    if (secret.length < 16) throw new AdvancedError(409, 'RUNNER_UNCONFIGURED', 'Jeton runner absent. Aucun appel distant.');
    res.json(await dispatchSandbox(ctx, project(ctx, req), param(req, 'missionId'), req.body, { runnerUrl: process.env.CORTEX_RUNNER_URL || 'http://127.0.0.1:8791', secret }));
  }));
}
