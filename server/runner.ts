import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open as openFile, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { HttpError, hashContent, safeEnvironment } from './security.js';
import type { Project } from '../shared/contracts.js';

export interface RunnerCapability {
  state: RunnerState;
  available: boolean;
  certified: boolean;
  backendAvailable: boolean;
  validationAvailable: boolean;
  certifiedExecutionAvailable: boolean;
  backend: 'podman-crun' | 'unavailable';
  backendVersion?: string;
  runtimeVersion?: string;
  isolationLevel: 'container' | 'none';
  networkModes: ('none' | 'allowlist')[];
  checks: RunnerChecks;
  reason?: string;
}

export type RunnerState = 'UNAVAILABLE' | 'INSTALLED' | 'PREREQUISITES_VERIFIED' | 'IMAGE_VERIFIED' | 'ATTESTED' | 'VALIDATED' | 'CERTIFIED';

export function cpuMaxForNanoCpus(nanoCpus: number, periodUs = 100_000): string | null {
  if (!Number.isSafeInteger(nanoCpus) || nanoCpus <= 0 || !Number.isSafeInteger(periodUs) || periodUs <= 0) return null;
  const quotaUs = Math.floor((nanoCpus * periodUs) / 1_000_000_000);
  return quotaUs > 0 ? `${quotaUs} ${periodUs}` : null;
}

export function containerIdsMatch(createdId: string, inspectedId: string): boolean {
  return Boolean(createdId && inspectedId && createdId === inspectedId);
}

export function imageDigestMatches(actualDigests: string[], expectedReference: string): boolean {
  const expected = expectedReference.split('@').at(-1) || '';
  return Boolean(expected && /^sha256:[a-f0-9]{64}$/u.test(expected) && actualDigests.length > 0 && actualDigests.some((digest) => digest.endsWith(expected)));
}

export function transitionRunnerState(state: RunnerState, proofs: { image: boolean; attestation: boolean; validation: boolean; storageQuota: boolean; seccompMeasured: boolean; expiresAt?: string }): RunnerState {
  if (proofs.expiresAt && Date.parse(proofs.expiresAt) <= Date.now()) return 'UNAVAILABLE';
  if (state === 'PREREQUISITES_VERIFIED' && proofs.image) return 'IMAGE_VERIFIED';
  if (state === 'IMAGE_VERIFIED' && proofs.attestation) return 'ATTESTED';
  if (state === 'ATTESTED' && proofs.validation) return 'VALIDATED';
  if (state === 'VALIDATED' && proofs.image && proofs.attestation && proofs.validation && proofs.storageQuota && proofs.seccompMeasured) return 'CERTIFIED';
  return state;
}

export type RunnerCheckStatus = 'pass' | 'fail' | 'not_run';
export interface RunnerCheck { status: RunnerCheckStatus; detail: string; }
export interface RunnerMappingCheck extends RunnerCheck {
  uidMap: string;
  gidMap: string;
  configuredUidRanges: string[];
  configuredGidRanges: string[];
  newuidmap: RunnerCheck;
  newgidmap: RunnerCheck;
}
export interface RunnerChecks {
  backend: RunnerCheck;
  mapping: RunnerMappingCheck;
  cgroups: RunnerCheck;
  seccomp: RunnerCheck;
  image: RunnerCheck;
  attestation: RunnerCheck;
  storage: RunnerCheck;
  isolation: RunnerCheck;
}

export interface RunnerLimits {
  timeoutMs: number;
  memoryBytes: number;
  pids: number;
  diskBytes: number;
  outputBytes: number;
}

export interface RunnerResult {
  output: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  runnerId: string;
  attestation: IsolationAttestation;
}

export interface IsolationAttestation {
  schema: 1;
  runnerId: string;
  nonce: string;
  containerId: string;
  imageId: string;
  imageDigest: string;
  backend: string;
  image: string;
  seccompHash: string;
  network: 'none' | 'allowlist';
  rootless: true;
  noNewPrivileges: true;
  capabilities: [];
  evidence: {
    uid: number;
    gid: number;
    capEff: string;
    noNewPrivileges: boolean;
    seccompMode: number;
    namespaces: Record<string, string>;
    cgroup: string;
    cgroupPath: string;
    cgroupPathExists: boolean;
    cpuMax: string;
    memoryMax: string;
    pidsMax: string;
    networkNone: boolean;
    networkIPv6None: boolean;
    cgroupControllers: string;
    rootReadOnly: boolean;
    hostSocketsAbsent: boolean;
    seccompProfileProof: 'not_run' | 'measured';
  };
  createdAt: string;
  expiresAt: string;
}

interface Spawned {
  child: ChildProcess;
  stdout: Buffer[];
  stderr: Buffer[];
  bytes: number;
  truncated: boolean;
  timedOut: boolean;
}

const DEFAULT_LIMITS: RunnerLimits = {
  timeoutMs: 300_000,
  memoryBytes: 2 * 1024 ** 3,
  pids: 128,
  diskBytes: 4 * 1024 ** 3,
  outputBytes: 2 * 1024 * 1024,
};
const O_CLOEXEC = 0o2000000;

function commandResult(executable: string, args: string[], timeoutMs = 5000): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: result.status ?? 127, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function safeId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(value)) throw new HttpError(400, 'Identifiant runner invalide.', 'RUNNER_ID_INVALID');
  return value;
}

function limits(input?: Partial<RunnerLimits>): RunnerLimits {
  const value = { ...DEFAULT_LIMITS, ...(input || {}) };
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 50 || value.timeoutMs > 1_800_000) throw new HttpError(400, 'Durée runner hors limites.', 'RUNNER_LIMIT_INVALID');
  if (!Number.isInteger(value.memoryBytes) || value.memoryBytes < 128 * 1024 ** 2 || value.memoryBytes > 16 * 1024 ** 3) throw new HttpError(400, 'Mémoire runner hors limites.', 'RUNNER_LIMIT_INVALID');
  if (!Number.isInteger(value.pids) || value.pids < 8 || value.pids > 2048) throw new HttpError(400, 'Limite PID runner invalide.', 'RUNNER_LIMIT_INVALID');
  if (!Number.isInteger(value.diskBytes) || value.diskBytes < 64 * 1024 ** 2 || value.diskBytes > 32 * 1024 ** 3) throw new HttpError(400, 'Disque runner hors limites.', 'RUNNER_LIMIT_INVALID');
  if (!Number.isInteger(value.outputBytes) || value.outputBytes < 1024 || value.outputBytes > 8 * 1024 * 1024) throw new HttpError(400, 'Sortie runner hors limites.', 'RUNNER_LIMIT_INVALID');
  return value;
}

interface IdRange { start: number; count: number; source: string; }
export function parseIdMap(value: string): Array<[number, number, number]> {
  return value.split('\n').map((line) => line.trim().split(/\s+/u).map(Number)).filter((row): row is [number, number, number] => row.length === 3 && row.every(Number.isInteger));
}
function readIdRanges(file: string, username: string): IdRange[] {
  try {
    return readFileSync(file, 'utf8').split('\n').map((line) => line.trim().split(':')).filter((parts) => parts.length === 3 && parts[0] === username).map((parts) => ({ start: Number(parts[1]), count: Number(parts[2]), source: `${file}:${parts[1]}:${parts[2]}` })).filter((range) => Number.isInteger(range.start) && Number.isInteger(range.count) && range.count > 0);
  } catch { return []; }
}
export function hasMappedSubrange(mapping: Array<[number, number, number]>, ranges: Array<{ start: number; count: number }>): boolean {
  return mapping.some(([containerId, hostId, count]) => containerId === 1 && count >= 65536 && ranges.some((range) => hostId >= range.start && hostId + count <= range.start + range.count));
}
function check(status: RunnerCheckStatus, detail: string): RunnerCheck { return { status, detail }; }
function emptyMapping(): RunnerMappingCheck {
  return { ...check('not_run', 'Mapping non inspecté.'), uidMap: '', gidMap: '', configuredUidRanges: [], configuredGidRanges: [], newuidmap: check('not_run', 'newuidmap non inspecté.'), newgidmap: check('not_run', 'newgidmap non inspecté.') };
}
function emptyChecks(): RunnerChecks {
  return { backend: check('not_run', 'Backend non inspecté.'), mapping: emptyMapping(), cgroups: check('not_run', 'cgroups non inspectés.'), seccomp: check('not_run', 'seccomp non inspecté.'), image: check('not_run', 'Image non inspectée.'), attestation: check('not_run', 'Attestation non exécutée.'), storage: check('not_run', 'Stockage non validé.'), isolation: check('not_run', 'Isolation non validée.') };
}

export class RunnerSupervisor {
  readonly seccompPath: string;
  readonly secureCopyScript: string;
  readonly image: string;
  private readonly dataDir: string;
  private readonly workflowPath: string;
  private readonly workflowSignaturePath: string;
  private readonly workflowKeyPath: string;
  private workflowCorrupt = false;
  private capabilityCache?: RunnerCapability;
  private certificationExpiresAt?: number;

  constructor(options: { dataDir: string; image?: string; seccompPath?: string }) {
    this.dataDir = path.resolve(options.dataDir);
    this.workflowPath = path.join(this.dataDir, 'runner-certification-workflow.json');
    this.workflowSignaturePath = `${this.workflowPath}.sig`;
    this.workflowKeyPath = process.env.CORTEX_WORKFLOW_KEY_FILE || path.join(os.homedir(), '.config', 'open-cortex', 'workflow.key');
    try {
      if (existsSync(this.workflowPath) || existsSync(this.workflowSignaturePath)) {
        const workflow = readFileSync(this.workflowPath, 'utf8');
        const expectedSignature = readFileSync(this.workflowSignaturePath, 'utf8').trim();
        const key = readFileSync(this.workflowKeyPath);
        const parsed = JSON.parse(workflow) as Record<string, unknown>;
        const signature = createHmac('sha256', key).update(workflow).digest('hex');
        if (!expectedSignature || signature !== expectedSignature || typeof parsed.state !== 'string' || !['UNAVAILABLE', 'PREREQUISITES_VERIFIED', 'IMAGE_VERIFIED', 'ATTESTED', 'VALIDATED', 'CERTIFIED'].includes(parsed.state)) this.workflowCorrupt = true;
      }
    } catch { this.workflowCorrupt = true; }
    this.image = options.image || process.env.CORTEX_RUNNER_IMAGE || '';
    this.seccompPath = path.resolve(options.seccompPath || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'security', 'seccomp-runner.json'));
    this.secureCopyScript = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'copy-workspace-secure.py'));
  }

  private cache(capability: RunnerCapability): RunnerCapability {
    this.capabilityCache = capability;
    return capability;
  }

  private async persistWorkflow(record: Record<string, unknown>): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const workflow = `${JSON.stringify({ ...record, writtenAt: new Date().toISOString() }, null, 2)}\n`;
    await mkdir(path.dirname(this.workflowKeyPath), { recursive: true, mode: 0o700 });
    if (!existsSync(this.workflowKeyPath)) await writeFile(this.workflowKeyPath, randomBytes(32), { mode: 0o600 });
    const key = await readFile(this.workflowKeyPath);
    const signature = createHmac('sha256', key).update(workflow).digest('hex');
    const tempWorkflow = `${this.workflowPath}.tmp-${process.pid}-${randomUUID()}`;
    const tempSignature = `${this.workflowSignaturePath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(tempWorkflow, workflow, { mode: 0o600 });
    await writeFile(tempSignature, `${signature}\n`, { mode: 0o600 });
    await rename(tempWorkflow, this.workflowPath);
    await rename(tempSignature, this.workflowSignaturePath);
  }

  private unavailable(reason: string, checks = emptyChecks(), state: RunnerState = 'UNAVAILABLE'): RunnerCapability {
    return this.cache({ state, available: false, certified: false, backendAvailable: false, validationAvailable: false, certifiedExecutionAvailable: false, backend: 'unavailable', isolationLevel: 'none', networkModes: [], checks, reason });
  }

  capability(force = false): RunnerCapability {
    if (this.workflowCorrupt) return this.unavailable('Workflow de certification absent, corrompu ou incohérent.', emptyChecks());
    if (this.capabilityCache && !force) {
      if (this.capabilityCache.state === 'CERTIFIED' && this.certificationExpiresAt !== undefined && this.certificationExpiresAt <= Date.now()) return this.unavailable('Certification expirée et révoquée.', { ...this.capabilityCache.checks, attestation: check('fail', 'Attestation expirée.') }, 'UNAVAILABLE');
      return this.capabilityCache;
    }
    const checks = emptyChecks();
    if (process.platform !== 'linux') return this.unavailable('Le backend certifié P0 est Linux uniquement.', checks);
    const imageReferenceValid = /^.+@sha256:[a-f0-9]{64}$/u.test(this.image);
    if (!this.image) checks.image = check('not_run', 'Image absente : prévalidation possible, construction rootless requise.');
    else if (!imageReferenceValid) checks.image = check('fail', 'L’image doit être épinglée par digest sha256.');
    if (!existsSync(this.seccompPath)) { checks.seccomp = check('fail', 'Profil seccomp absent.'); return this.unavailable('Profil seccomp absent.', checks); }
    try { if (!statSync(this.seccompPath).isFile()) throw new Error('seccomp non-fichier'); } catch { checks.seccomp = check('fail', 'Profil seccomp inaccessible.'); return this.unavailable('Profil seccomp inaccessible.', checks); }
    const podman = commandResult('podman', ['info', '--format', 'json'], 8000);
    if (podman.status !== 0) { checks.backend = check('fail', `Podman indisponible: ${podman.stderr.trim().slice(0, 240) || 'commande absente'}`); return this.unavailable(checks.backend.detail, checks); }
    const crun = commandResult('crun', ['--version'], 3000);
    if (crun.status !== 0) { checks.backend = check('fail', 'crun indisponible.'); return this.unavailable(checks.backend.detail, checks); }
    checks.backend = check('pass', `Podman et crun disponibles; rootless à confirmer avec les preuves suivantes. Podman ${podman.stdout.includes('"rootless":true') ? 'annonce rootless' : 'rootless non confirmé'}.`);
    const username = os.userInfo().username;
    const uidRanges = readIdRanges('/etc/subuid', username), gidRanges = readIdRanges('/etc/subgid', username);
    const uidMapText = commandResult('podman', ['unshare', 'cat', '/proc/self/uid_map'], 5000);
    const gidMapText = commandResult('podman', ['unshare', 'cat', '/proc/self/gid_map'], 5000);
    const uidMap = parseIdMap(uidMapText.stdout), gidMap = parseIdMap(gidMapText.stdout);
    const newuidmap = commandResult('sh', ['-lc', 'command -v newuidmap'], 3000);
    const newgidmap = commandResult('sh', ['-lc', 'command -v newgidmap'], 3000);
    checks.mapping = { status: uidMapText.status === 0 && gidMapText.status === 0 && hasMappedSubrange(uidMap, uidRanges) && hasMappedSubrange(gidMap, gidRanges) && newuidmap.status === 0 && newgidmap.status === 0 ? 'pass' : 'fail', detail: 'Mapping réel et plages subuid/subgid vérifiés.', uidMap: uidMapText.stdout.trim(), gidMap: gidMapText.stdout.trim(), configuredUidRanges: uidRanges.map((range) => range.source), configuredGidRanges: gidRanges.map((range) => range.source), newuidmap: newuidmap.status === 0 ? check('pass', newuidmap.stdout.trim()) : check('fail', 'newuidmap absent ou inutilisable.'), newgidmap: newgidmap.status === 0 ? check('pass', newgidmap.stdout.trim()) : check('fail', 'newgidmap absent ou inutilisable.') };
    if (checks.mapping.status === 'fail') return this.unavailable('Cartographie UID/GID rootless complète absente ou helpers newuidmap/newgidmap invalides.', checks);
    let info: Record<string, unknown>;
    try { info = JSON.parse(podman.stdout) as Record<string, unknown>; } catch { checks.backend = check('fail', 'Podman info non JSON.'); return this.unavailable(checks.backend.detail, checks); }
    const host = (info.host || {}) as Record<string, unknown>;
    const security = (host.security || {}) as Record<string, unknown>;
    const runtimeInfo = host.ociRuntime;
    const runtime = typeof runtimeInfo === 'string' ? runtimeInfo : String((runtimeInfo as Record<string, unknown> | undefined)?.name || host.OCIRuntime || '');
    const rootless = security.rootless === true;
    const cgroupVersion = String(host.cgroupVersion || '');
    checks.cgroups = cgroupVersion === 'v2' ? check('pass', 'Podman rapporte cgroups v2.') : check('fail', `cgroups v2 requis, valeur observée: ${cgroupVersion || 'absente'}.`);
    checks.seccomp = security.seccompEnabled === true ? check('pass', 'seccomp activé dans Podman.') : check('fail', 'seccomp désactivé dans Podman.');
    const image = imageReferenceValid ? commandResult('podman', ['image', 'exists', this.image], 8000) : { status: 1, stdout: '', stderr: '' };
    if (imageReferenceValid) checks.image = image.status === 0 ? check('pass', 'Image présente localement sous le digest demandé.') : check('fail', 'Image runner absente localement : construire rootless avant validation.');
    checks.attestation = check('not_run', 'Attestation non exécutée avant un lancement réel.');
    checks.storage = check('fail', 'Quota du workspace complet non validé par capability().');
    checks.isolation = check('not_run', 'Isolation réelle non exécutée.');
    if (!rootless) { checks.backend = check('fail', 'Podman n’est pas rootless.'); return this.unavailable(checks.backend.detail, checks, 'INSTALLED'); }
    if (checks.cgroups.status === 'fail' || !/crun/iu.test(runtime) || checks.seccomp.status === 'fail') return this.unavailable('Prérequis système ou sécurité incomplets.', checks, 'INSTALLED');
    if (!imageReferenceValid || image.status !== 0) return this.cache({ state: 'PREREQUISITES_VERIFIED', available: false, certified: false, backendAvailable: true, validationAvailable: false, certifiedExecutionAvailable: false, backend: 'podman-crun', backendVersion: String((info.version as Record<string, unknown> | undefined)?.Version || info.version || 'unknown'), runtimeVersion: crun.stdout.trim().split('\n')[0], isolationLevel: 'container', networkModes: ['none'], checks, reason: 'Backend disponible; image requise pour la validation contrôlée. Exécution non fiable interdite.' });
    return this.cache({ state: 'IMAGE_VERIFIED', available: false, certified: false, backendAvailable: true, validationAvailable: true, certifiedExecutionAvailable: false, backend: 'podman-crun', backendVersion: String((info.version as Record<string, unknown> | undefined)?.Version || info.version || 'unknown'), runtimeVersion: crun.stdout.trim().split('\n')[0], isolationLevel: 'container', networkModes: ['none'], checks, reason: 'Validation contrôlée disponible; attestation, tests, quota et certification restent obligatoires.' });
  }

  requireAvailable(): RunnerCapability {
    const capability = this.capability();
    if (!capability.available || !capability.certified) throw new HttpError(503, capability.reason || 'Runner isolé certifié indisponible.', 'ISOLATION_UNAVAILABLE');
    return capability;
  }

  async validateRunner(): Promise<RunnerCapability> {
    const capability = this.capability(true);
    if (!capability.backendAvailable || !capability.validationAvailable) throw new HttpError(503, capability.reason || 'Validation contrôlée indisponible.', 'RUNNER_VALIDATION_UNAVAILABLE');
    const runnerId = `validation-${randomUUID()}`;
    const root = await mkdtemp(path.join(os.tmpdir(), 'cortex-validation-'));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const nonce = randomBytes(32).toString('base64url');
    const seccompHash = hashContent(await readFile(this.seccompPath));
    let containerId = '';
    try {
      const imageIdentity = this.inspectImageIdentity(this.image);
      const args = this.podmanArgs(runnerId, workspace, { ...DEFAULT_LIMITS, timeoutMs: 15_000, outputBytes: 16 * 1024 }, 'create');
      args.push('--env', `CORTEX_PROBE_NONCE=${nonce}`, this.image, '--', '/bin/sh', '-lc', this.probeCommand());
      const created = await this.spawnBounded('podman', args, { ...DEFAULT_LIMITS, timeoutMs: 30_000, outputBytes: 16 * 1024 });
      containerId = created.output.trim().split(/\s+/u).at(-1) || '';
      if (created.exitCode !== 0 || !containerId) throw new HttpError(503, 'Création du conteneur de validation échouée.', 'RUNNER_VALIDATION_CREATE_FAILED');
      const inspect = commandResult('podman', ['inspect', containerId], 8000);
      if (inspect.status !== 0 || !this.verifyContainerConfig(inspect.stdout, runnerId, containerId, imageIdentity)) throw new HttpError(503, 'Inspection host-side du conteneur de validation échouée.', 'RUNNER_VALIDATION_INSPECT_FAILED');
      const result = await this.spawnBounded('podman', ['start', '--attach', containerId], { ...DEFAULT_LIMITS, timeoutMs: 15_000, outputBytes: 16 * 1024 });
      if (!this.verifyEffectiveLimits(result.output, inspect.stdout, DEFAULT_LIMITS)) throw new HttpError(503, 'Limites cgroup observées différentes de la configuration host-side.', 'RUNNER_CGROUP_LIMIT_MISMATCH');
      const attestation = this.attestationFromOutput(result.output, runnerId, nonce, this.image, seccompHash, capability, containerId, inspect.stdout);
      const validatedState = transitionRunnerState('ATTESTED', { image: true, attestation: true, validation: result.output.includes('escape-suite-pass'), storageQuota: false, seccompMeasured: attestation.evidence.seccompProfileProof === 'measured', expiresAt: attestation.expiresAt });
      const validatedChecks = { ...(this.capabilityCache?.checks || capability.checks), isolation: result.output.includes('escape-suite-pass') ? check('pass', 'Suite d’évasion du conteneur de validation observée.') : check('not_run', 'Suite d’évasion complète non exécutée.') };
      this.cache({ ...(this.capabilityCache || capability), state: validatedState, checks: validatedChecks, reason: validatedState === 'VALIDATED' ? 'Validation obtenue; quota global requis avant certification.' : 'Validation incomplète; preuves d’évasion ou de quota manquantes.' });
      await this.persistWorkflow({ state: validatedState, runnerId, containerId: attestation.containerId, imageId: attestation.imageId, imageDigest: attestation.imageDigest, nonce, createdAt: attestation.createdAt, expiresAt: attestation.expiresAt, checks: validatedChecks });
      return this.capabilityCache || capability;
    } catch (error) {
      this.capabilityCache = { ...capability, validationAvailable: false, certifiedExecutionAvailable: false, checks: { ...capability.checks, attestation: check('fail', error instanceof Error ? error.message : 'Validation contrôlée échouée.') }, reason: 'Validation contrôlée échouée; exécution non fiable interdite.' };
      await this.persistWorkflow({ state: 'UNAVAILABLE', reason: error instanceof Error ? error.message : 'Validation contrôlée échouée.', checks: this.capabilityCache.checks });
      throw error;
    } finally {
      if (containerId) commandResult('podman', ['rm', '--force', containerId], 8000);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async execute(project: Project, command: string, input: { kind?: 'command' | 'test'; limits?: Partial<RunnerLimits>; env?: Record<string, string> } = {}): Promise<RunnerResult> {
    const capability = this.requireAvailable();
    if (!project.path || !path.isAbsolute(project.path)) throw new HttpError(403, 'Chemin projet invalide.', 'PROJECT_PATH_CHANGED');
    const runnerId = randomUUID();
    const root = await mkdtemp(path.join(os.tmpdir(), 'cortex-runner-'));
    const workspace = path.join(root, 'workspace');
    const limitsValue = limits(input.limits);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    try {
      this.requireOpenat2();
      const beforeCopy = await this.safeTreeSnapshot(project.path);
      const copied = commandResult('python3', [this.secureCopyScript, project.path, workspace], 30_000);
      if (copied.status !== 0) throw new HttpError(403, `Copie sécurisée du workspace refusée: ${copied.stderr.trim().slice(0, 240)}`, 'RUNNER_SECURE_COPY_FAILED');
      const afterCopy = await this.safeTreeSnapshot(project.path);
      if (beforeCopy.size !== afterCopy.size || [...beforeCopy].some(([name, fingerprint]) => afterCopy.get(name) !== fingerprint)) throw new HttpError(409, 'Workspace modifié pendant la préparation du runner.', 'RUNNER_WORKSPACE_TOCTOU');
      const nonce = randomBytes(32).toString('base64url');
      const seccompHash = hashContent(await readFile(this.seccompPath));
      const imageIdentity = this.inspectImageIdentity(this.image);
      const args = this.podmanArgs(runnerId, workspace, limitsValue, 'create');
      args.push('--env', `CORTEX_PROBE_NONCE=${nonce}`);
      for (const [key, value] of Object.entries(input.env || {})) {
        if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(key) || /[\0\r\n]/u.test(value)) throw new HttpError(400, 'Variable runner invalide.', 'RUNNER_ENV_INVALID');
        args.push('--env', `${key}=${value}`);
      }
      args.push(this.image);
      args.push('--', '/bin/sh', '-lc', `${this.probeCommand()} && ( ${command} )`);
      const created = await this.spawnBounded('podman', args, { ...limitsValue, timeoutMs: 30_000, outputBytes: 64 * 1024 });
      const containerId = created.output.trim().split(/\s+/u).at(-1);
      if (created.exitCode !== 0 || !containerId) throw new HttpError(503, 'Création du conteneur réel échouée.', 'ISOLATION_CONTAINER_CREATE_FAILED');
      try {
        const inspect = commandResult('podman', ['inspect', containerId], 8000);
        if (inspect.status !== 0 || !this.verifyContainerConfig(inspect.stdout, runnerId, containerId, imageIdentity)) throw new HttpError(503, 'Configuration effective du conteneur non vérifiable.', 'ISOLATION_CONTAINER_CONFIG_FAILED');
        const started = Date.now();
        const result = await this.spawnBounded('podman', ['start', '--attach', containerId], limitsValue);
        if (!this.verifyEffectiveLimits(result.output, inspect.stdout, limitsValue)) throw new HttpError(503, 'Limites cgroup observées différentes de la configuration host-side.', 'RUNNER_CGROUP_LIMIT_MISMATCH');
        const attestation = this.attestationFromOutput(result.output, runnerId, nonce, this.image, seccompHash, capability, containerId, inspect.stdout);
        return { ...result, durationMs: Date.now() - started, runnerId, attestation };
      } finally {
        commandResult('podman', ['rm', '--force', containerId], 8000);
      }
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async safeTreeSnapshot(root: string): Promise<Map<string, string>> {
    const snapshot = new Map<string, string>();
    const visit = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const target = path.join(current, entry.name);
        const info = await lstat(target);
        if (info.isSymbolicLink() || info.isBlockDevice() || info.isCharacterDevice() || info.isSocket() || info.isFIFO() || info.nlink > 1) throw new HttpError(403, 'Workspace non fiable : lien, fichier spécial ou hardlink refusé.', 'RUNNER_WORKSPACE_UNSAFE');
        const handle = await openFile(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | O_CLOEXEC).catch(() => undefined);
        if (!handle) throw new HttpError(403, 'Workspace non fiable : ouverture sans suivi de lien impossible.', 'RUNNER_WORKSPACE_OPEN_FAILED');
        const opened = await handle.stat().finally(() => handle.close());
        if (opened.dev !== info.dev || opened.ino !== info.ino || opened.mode !== info.mode || opened.nlink !== info.nlink) throw new HttpError(409, 'Identité du workspace modifiée pendant la vérification.', 'RUNNER_WORKSPACE_TOCTOU');
        snapshot.set(path.relative(root, target), [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs, info.nlink].join(':'));
        if (info.isDirectory()) await visit(target);
      }
    };
    await visit(root);
    return snapshot;
  }

  private requireOpenat2(): void {
    const probe = commandResult('python3', ['-c', 'import ctypes, errno, os\nlibc=ctypes.CDLL(None, use_errno=True)\nclass How(ctypes.Structure):\n _fields_=[("flags",ctypes.c_ulonglong),("mode",ctypes.c_ulonglong),("resolve",ctypes.c_ulonglong)]\nhow=How(0,0,0)\nfd=libc.syscall(437, -100, ctypes.c_char_p(b"."), ctypes.byref(how), ctypes.sizeof(how))\nerr=ctypes.get_errno()\nif fd >= 0: os.close(fd); raise SystemExit(0)\nraise SystemExit(77 if err == errno.ENOSYS else 1)'], 3000);
    if (probe.status !== 0) throw new HttpError(503, 'openat2 indisponible : copie sûre du workspace refusée.', 'RUNNER_OPENAT2_UNAVAILABLE');
  }

  private inspectImageIdentity(reference: string): { imageId: string; imageDigest: string } {
    const inspected = commandResult('podman', ['image', 'inspect', '--format', 'json', reference], 8000);
    if (inspected.status !== 0) throw new HttpError(503, 'Identité de l’image impossible à mesurer.', 'ISOLATION_IMAGE_IDENTITY_UNAVAILABLE');
    try {
      const item = (JSON.parse(inspected.stdout) as Array<Record<string, unknown>>)[0];
      const imageId = String(item?.Id || '');
      const digests = (Array.isArray(item?.RepoDigests) ? item.RepoDigests : []).map(String);
      if (!imageId || !imageDigestMatches(digests, reference)) throw new HttpError(503, 'Digest d’image absent ou substitué.', 'ISOLATION_IMAGE_DIGEST_MISMATCH');
      return { imageId, imageDigest: reference.split('@').at(-1) || '' };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'Identité d’image ambiguë.', 'ISOLATION_IMAGE_IDENTITY_INVALID');
    }
  }

  private verifyContainerConfig(raw: string, runnerId: string, expectedId: string, expectedImage: { imageId: string; imageDigest: string }): boolean {
    try {
      const item = (JSON.parse(raw) as Array<Record<string, unknown>>)[0];
      const config = (item?.Config || {}) as Record<string, unknown>;
      const host = (item?.HostConfig || {}) as Record<string, unknown>;
      const securityOpt = JSON.stringify(host.SecurityOpt || []);
      const mounts = JSON.stringify(host.Mounts || item?.Mounts || []);
      const repoDigests = (Array.isArray(item?.RepoDigests) ? item.RepoDigests : Array.isArray(config.RepoDigests) ? config.RepoDigests : []).map(String);
      const expectedName = `/cortex-${runnerId}`;
      return String(item?.Id || '') === expectedId && String(item?.Name || '') === expectedName && String(item?.Image || '') === expectedImage.imageId && imageDigestMatches(repoDigests, expectedImage.imageDigest) && securityOpt.includes('no-new-privileges') && securityOpt.includes('seccomp') && String(host.NetworkMode || '') === 'none' && host.ReadonlyRootfs === true && String(host.PidMode || '') === 'private' && String(host.CgroupnsMode || '') === 'private' && mounts.includes('/workspace');
    } catch { return false; }
  }

  private containerIdentity(raw: string, runnerId: string, expectedId: string, expectedImage: string): { containerId: string; imageId: string; imageDigest: string } {
    try {
      const item = (JSON.parse(raw) as Array<Record<string, unknown>>)[0];
      const config = (item?.Config || {}) as Record<string, unknown>;
      const imageDigest = expectedImage.split('@').at(-1) || '';
      const repoDigests = (Array.isArray(item?.RepoDigests) ? item.RepoDigests : Array.isArray(config.RepoDigests) ? config.RepoDigests : []).map(String);
      const containerId = String(item?.Id || '');
      const imageId = String(item?.Image || config.Image || '');
      if (!containerId || !containerIdsMatch(expectedId, containerId) || String(item?.Name || '') !== `/cortex-${runnerId}` || !imageDigestMatches(repoDigests, expectedImage)) throw new HttpError(503, 'Identité du conteneur ou digest d’image incohérent.', 'ISOLATION_IDENTITY_MISMATCH');
      return { containerId, imageId, imageDigest };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'Identité du conteneur non mesurable.', 'ISOLATION_IDENTITY_UNAVAILABLE');
    }
  }

  private attestationFromOutput(output: string, runnerId: string, nonce: string, image: string, seccompHash: string, capability: RunnerCapability, containerId: string, rawInspect: string): IsolationAttestation {
    if (!output.includes('runner-attestation-ok')) throw new HttpError(503, 'Sonde du conteneur d’exécution échouée.', 'ISOLATION_ATTESTATION_FAILED');
    const identity = this.containerIdentity(rawInspect, runnerId, containerId, image);
    const evidence = this.parseAttestationEvidence(output, runnerId, nonce, image, seccompHash);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30_000).toISOString();
    this.certificationExpiresAt = Date.parse(expiresAt);
    const nextState = transitionRunnerState(capability.state, { image: true, attestation: true, validation: false, storageQuota: false, seccompMeasured: evidence.seccompProfileProof === 'measured', expiresAt });
    this.cache({ ...capability, state: nextState, checks: { ...capability.checks, attestation: check('pass', 'Attestation liée au conteneur réel.') }, reason: 'Attestation obtenue; validation, preuve seccomp et quota global restent obligatoires.' });
    return { schema: 1, runnerId, nonce, containerId: identity.containerId, imageId: identity.imageId, imageDigest: identity.imageDigest, backend: capability.backend, image, seccompHash, network: 'none', rootless: true, noNewPrivileges: true, capabilities: [], evidence, createdAt: now.toISOString(), expiresAt };
  }

  private verifyEffectiveLimits(output: string, rawInspect: string, expected: RunnerLimits): boolean {
    try {
      const item = (JSON.parse(rawInspect) as Array<Record<string, unknown>>)[0];
      const host = (item?.HostConfig || {}) as Record<string, unknown>;
      const values = new Map(output.split('\n').map((line) => line.split('=', 2) as [string, string]));
      const cpu = values.get('cpuMax') || '';
      const memory = Number(values.get('memoryMax'));
      const pids = Number(values.get('pidsMax'));
      const hostMemory = Number(host.Memory), hostPids = Number(host.PidsLimit), hostNanoCpus = Number(host.NanoCpus), hostPeriod = Number(host.CpuPeriod) || 100_000;
      const cpuExpected = cpuMaxForNanoCpus(hostNanoCpus, hostPeriod) || '';
      return hostMemory === expected.memoryBytes && hostPids === expected.pids && memory === hostMemory && pids === hostPids && Boolean(cpuExpected) && cpu === cpuExpected;
    } catch { return false; }
  }

  private parseAttestationEvidence(output: string, runnerId: string, nonce: string, image: string, seccompHash: string): IsolationAttestation['evidence'] {
    const values = new Map(output.split('\n').map((line) => line.split('=' , 2) as [string, string]).filter(([key, value]) => Boolean(key && value)));
    const uid = Number(values.get('uid')), gid = Number(values.get('gid')), seccompMode = Number(values.get('seccompMode'));
    const namespaces: Record<string, string> = {};
    for (const ns of ['user', 'pid', 'net', 'mnt', 'ipc', 'uts', 'cgroup']) namespaces[ns] = values.get(`ns_${ns}`) || '';
    const seccompProfileProof: 'not_run' | 'measured' = values.get('seccompProfileProof') === 'measured' ? 'measured' : 'not_run';
    const evidence = { uid, gid, capEff: values.get('capEff') || '', noNewPrivileges: values.get('noNewPrivileges') === '1', seccompMode, namespaces, cgroup: values.get('cgroup') || '', cgroupPath: values.get('cgroupPath') || '', cgroupPathExists: values.get('cgroupPathExists') === 'true', cpuMax: values.get('cpuMax') || '', memoryMax: values.get('memoryMax') || '', pidsMax: values.get('pidsMax') || '', networkNone: values.get('networkNone') === 'true', networkIPv6None: values.get('networkIPv6None') === 'true', cgroupControllers: values.get('cgroupControllers') || '', rootReadOnly: values.get('rootReadOnly') === 'true', hostSocketsAbsent: values.get('hostSocketsAbsent') === 'true', seccompProfileProof };
    if (values.get('nonce') !== nonce || !Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || !evidence.noNewPrivileges || !/^0+$/.test(evidence.capEff) || ![1, 2].includes(seccompMode) || Object.values(namespaces).some((value) => !/^\w+:\[\d+\]$/u.test(value)) || !evidence.cgroup || !evidence.cgroupPathExists || !evidence.cpuMax || evidence.cpuMax === 'max' || !evidence.memoryMax || evidence.memoryMax === 'max' || !evidence.pidsMax || evidence.pidsMax === 'max' || !evidence.networkNone || !evidence.networkIPv6None || !/\bcpu\b/.test(evidence.cgroupControllers) || !/\bmemory\b/.test(evidence.cgroupControllers) || !/\bpids\b/.test(evidence.cgroupControllers) || !evidence.rootReadOnly || !evidence.hostSocketsAbsent || evidence.seccompProfileProof !== 'measured') throw new HttpError(503, `Attestation incomplète pour ${runnerId}.`, 'ISOLATION_ATTESTATION_FAILED');
    return evidence;
  }

  private probeCommand(): string {
    return '/usr/local/bin/cortex-runner-probe';
  }

  private podmanArgs(runnerId: string, workspace: string, value: RunnerLimits, operation: 'run' | 'create' = 'run'): string[] {
    return [operation, '--rm', '--name', `cortex-${safeId(runnerId)}`, '--label', 'io.cortex.managed=true', '--label', `io.cortex.runner-id=${runnerId}`, '--userns=private', '--user', '1000:1000', '--pid=private', '--ipc=private', '--uts=private', '--cgroupns=private', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges:true', '--security-opt', `seccomp=${this.seccompPath}`, '--memory', String(value.memoryBytes), '--memory-swap', String(value.memoryBytes), '--cpus', '2', '--pids-limit', String(value.pids), '--ulimit', 'nofile=1024:1024', '--tmpfs', `/tmp:rw,nosuid,nodev,noexec,size=${Math.min(value.diskBytes, 512 * 1024 ** 2)}`, '--mount', `type=bind,src=${workspace},dst=/workspace,rw,nodev,nosuid`, '--workdir', '/workspace', '--env', 'HOME=/tmp/home', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin', '--env', 'LANG=C.UTF-8', '--env', 'LC_ALL=C.UTF-8', '--env', 'CI=1', '--env', 'NO_COLOR=1'];
  }

  private spawnBounded(executable: string, args: string[], value: RunnerLimits): Promise<{ output: string; exitCode: number | null; signal: string | null; timedOut: boolean; truncated: boolean }> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const child = spawn(executable, args, { env: safeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true });
      const state: Spawned = { child, stdout: [], stderr: [], bytes: 0, truncated: false, timedOut: false };
      const terminate = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
      const timer = setTimeout(() => { state.timedOut = true; terminate(); }, value.timeoutMs);
      const consume = (chunk: Buffer) => { if (state.bytes < value.outputBytes) { const accepted = chunk.subarray(0, value.outputBytes - state.bytes); state.stdout.push(accepted); } state.bytes += chunk.length; if (state.bytes > value.outputBytes) { state.truncated = true; terminate(); } };
      child.stdout.on('data', consume); child.stderr.on('data', consume);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (exitCode, signal) => { clearTimeout(timer); terminate(); resolve({ output: Buffer.concat([...state.stdout, ...state.stderr]).toString('utf8'), exitCode, signal, timedOut: state.timedOut, truncated: state.truncated }); });
      void started;
    });
  }
}
