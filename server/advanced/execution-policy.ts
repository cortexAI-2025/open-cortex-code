import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isSensitivePath } from '../security.js';
import { isProtectedBranch } from './git-publish.js';
import { now } from './common.js';

export type IsolationDemand = 'required' | 'local';
export type PolicyCode =
  | 'ALLOW' | 'COMMAND_DENIED' | 'PATH_DENIED' | 'SENSITIVE_FILE' | 'SYMLINK_ESCAPE'
  | 'PROTECTED_BRANCH' | 'FORCE_PUSH_DENIED' | 'PUBLISH_PERMISSION' | 'NETWORK_NOT_ENFORCED'
  | 'LLM_BUDGET' | 'PROVIDER_SWITCH_DENIED' | 'CIRCUIT_OPEN' | 'PROVIDER_CONCURRENCY';

export interface PolicyDecision { allowed: boolean; code: PolicyCode | string; reason: string; at: string }
export interface ExecutionPolicy {
  allowedCommands: string[];
  timeoutMs: number;
  memoryMb: number;
  cpus: number;
  maxProcesses: number;
  network: 'deny' | 'allow';
  isolation: IsolationDemand;
  git: { allowCommit: boolean; allowPush: boolean; allowPullRequest: boolean };
  tokenBudget: number;
  maxLlmCalls: number;
  maxRetries: number;
  backoffMs: number;
}

const FLAGS = new Set(['--test', '--experimental-strip-types', '-m', '-q']);
const WORDS = new Set(['unittest']);
const COMMANDS = new Set(['node', 'python', 'python3', 'pytest']);

export function defaultPolicy(partial: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    allowedCommands: ['node', 'python3', 'pytest'],
    timeoutMs: 15_000,
    memoryMb: 256,
    cpus: 1,
    maxProcesses: 64,
    network: 'deny',
    isolation: 'local',
    tokenBudget: 20_000,
    maxLlmCalls: 3,
    maxRetries: 2,
    backoffMs: 400,
    ...partial,
    git: { allowCommit: false, allowPush: false, allowPullRequest: false, ...partial.git },
  };
}

const deny = (code: PolicyCode, reason: string): PolicyDecision => ({ allowed: false, code, reason, at: now() });
const allow = (reason: string): PolicyDecision => ({ allowed: true, code: 'ALLOW', reason, at: now() });

/** Jetonise sans shell. Refuse les métacaractères, git et toute commande hors liste. */
export function decideCommand(policy: ExecutionPolicy, command: string): PolicyDecision {
  if (!command || command.length > 500 || /[\0\r\n;&|`$<>\\"'()]/.test(command) || command.includes('..')) {
    return deny('COMMAND_DENIED', 'Commande refusée : shell, métacaractère ou traversée.');
  }
  const parts = command.trim().split(/\s+/).filter(Boolean);
  const executable = parts[0] ?? '';
  if (!COMMANDS.has(executable) || !policy.allowedCommands.includes(executable)) {
    return deny('COMMAND_DENIED', `Exécutable refusé : ${executable || 'vide'}. Git, rm, sudo, curl et le shell ne passent pas par cet adaptateur.`);
  }
  for (const part of parts.slice(1)) {
    if (FLAGS.has(part) || WORDS.has(part)) continue;
    if (part.startsWith('-')) return deny('COMMAND_DENIED', `Option refusée : ${part}.`);
    if (!/^[A-Za-z0-9_./-]+$/.test(part)) return deny('COMMAND_DENIED', 'Argument refusé.');
  }
  if (/\s(?:--force|--force-with-lease|-f)(?:\s|$)/.test(` ${command} `) || command.includes('docker.sock')) {
    return deny('COMMAND_DENIED', 'Argument dangereux refusé.');
  }
  return allow(`Commande acceptée : ${executable}.`);
}

export function commandPaths(command: string): string[] {
  return command.trim().split(/\s+/).filter((part) => part.includes('/') || /\.(?:js|mjs|cjs|ts|tsx|py)$/.test(part));
}

export async function decidePath(projectPath: string, relative: string): Promise<PolicyDecision> {
  if (!relative || relative.length > 500 || relative.startsWith('/') || relative.includes('\\') || relative.split('/').includes('..') || relative.split('/').includes('.')) {
    return deny('PATH_DENIED', 'Chemin hors du projet.');
  }
  if (isSensitivePath(relative)) return deny('SENSITIVE_FILE', 'Fichier sensible refusé.');
  let root: string;
  try { root = await realpath(projectPath); } catch { return deny('PATH_DENIED', 'Racine illisible.'); }
  let current = root;
  for (const part of relative.split('/').filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (!info) {
      if (current !== root && !current.startsWith(`${root}${path.sep}`)) return deny('PATH_DENIED', 'Chemin hors du projet.');
      continue;
    }
    if (info.isSymbolicLink()) {
      const resolved = await realpath(current).catch(() => '');
      if (!resolved || (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))) return deny('SYMLINK_ESCAPE', 'Lien symbolique hors du projet.');
      current = resolved;
    }
  }
  return allow(relative);
}

export function decideGit(policy: ExecutionPolicy, action: 'commit' | 'push' | 'pull-request', branch: string, force = false): PolicyDecision {
  if (force || action === 'push' && /\s--force/.test(branch)) return deny('FORCE_PUSH_DENIED', 'Push forcé refusé. Aucun --force.');
  if (!branch || isProtectedBranch(branch)) return deny('PROTECTED_BRANCH', `Branche protégée « ${branch || 'inconnue'} ».`);
  if (action === 'commit' && !policy.git.allowCommit) return deny('PUBLISH_PERMISSION', 'allowCommit est indépendant et manquant.');
  if (action === 'push' && !policy.git.allowPush) return deny('PUBLISH_PERMISSION', 'allowPush est indépendant et manquant.');
  if (action === 'pull-request' && !policy.git.allowPullRequest) return deny('PUBLISH_PERMISSION', 'allowPullRequest est indépendant et manquant.');
  return allow(`${action} autorisé sur ${branch}.`);
}

export interface DockerSpec {
  name: string;
  image: string;
  projectPath: string;
  command: string[];
  policy: ExecutionPolicy;
}

/** Argv Docker. Jamais de socket, jamais privileged, réseau coupé par défaut. */
export function dockerRunArgs(spec: DockerSpec): string[] {
  if (!/^cortex-exec-[a-z0-9-]{8,64}$/.test(spec.name)) throw new Error('Nom de conteneur refusé.');
  if (spec.image.includes('/') && spec.image.split('/').length > 2) throw new Error('Image refusée.');
  const network = spec.policy.network === 'allow' ? 'bridge' : 'none';
  const args = [
    'run', '--rm', '--name', spec.name,
    '--user', '65534:65534',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--network', network,
    '--memory', `${spec.policy.memoryMb}m`,
    '--cpus', String(spec.policy.cpus),
    '--pids-limit', String(spec.policy.maxProcesses),
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--workdir', '/workspace',
    '-v', `${spec.projectPath}:/workspace:ro`,
    spec.image,
    ...spec.command,
  ];
  if (args.some((arg) => arg.includes('docker.sock') || arg === '--privileged' || arg.includes('/.env'))) throw new Error('Montage interdit.');
  return args;
}
