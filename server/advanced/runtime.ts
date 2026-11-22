import path from 'node:path';
import type { Express } from 'express';
import { z } from 'zod';
import type { Project } from '../../shared/contracts.js';
import { AdvancedError, type Context, all, confirmed, id, now, owned, param, project, redact, route, trusted } from './common.js';
import { commitPaths, isProtectedBranch, openPullRequest, pushFeatureBranch } from './git-publish.js';
import { cancelMission, presentMission, storeMission, type Mission } from './mission.js';
import { pathsOverlap } from './orchestrator.js';
import { git, gitOk, runCommand } from './process.js';
import { runAgentMission, type AgentDriver } from './agent-mission.js';
import { pathInScope } from './repair.js';

export type RuntimeStatus = 'pending' | 'ready' | 'running' | 'passed' | 'failed' | 'blocked' | 'cancelled';
export type AgentRole = 'architect' | 'coder' | 'tester' | 'reviewer' | 'git-manager';
export interface RuntimeTask {
  id: string;
  key: string;
  role: AgentRole;
  agentId: string;
  title: string;
  status: RuntimeStatus;
  dependsOn: string[];
  paths: string[];
  git: boolean;
  isolate: boolean;
  runs: number;
  worktree?: string;
  result?: string;
  startedAt?: string;
  finishedAt?: string;
}
export interface MissionMemory {
  id: string;
  schemaVersion: 1;
  version: number;
  projectId: string;
  missionId: string;
  objective: string;
  plan: { key: string; role: AgentRole; status: RuntimeStatus }[];
  decisions: { at: string; agent: string; text: string }[];
  files: string[];
  tests: { command: string; exitCode: number | null; at: string }[];
  errors: string[];
  corrections: string[];
  checkpoints: { at: string; key: string; status: RuntimeStatus }[];
  sessions: string[];
  tokens: { input: number; output: number; byAgent: Record<string, { input: number; output: number }> };
  updatedAt: string;
}
export interface MissionRuntime {
  id: string;
  projectId: string;
  missionId: string;
  status: 'pending' | 'running' | 'paused' | 'blocked' | 'failed' | 'passed' | 'cancelled';
  concurrency: number;
  tasks: RuntimeTask[];
  activeAgents: string[];
  branch: string;
  control: 'run' | 'pause' | 'cancel';
  parallelWaves: number;
  pullRequestUrl: string | null;
  remoteCertified: boolean;
  tokens: { input: number; output: number };
  corrections: string[];
  createdAt: string;
  updatedAt: string;
}

const running = new Set<string>();
const locks = new Map<string, { paths: string[]; branch?: string }>();
const RANK: AgentRole[] = ['architect', 'coder', 'tester', 'reviewer', 'git-manager'];

export function markReady(tasks: RuntimeTask[]): RuntimeTask[] {
  const map = new Map(tasks.map((task) => [task.id, { ...task }]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of map.values()) {
      if (task.status !== 'pending' && task.status !== 'ready') continue;
      const deps = task.dependsOn.map((dep) => map.get(dep)).filter((item): item is RuntimeTask => !!item);
      if (deps.some((dep) => dep.status === 'cancelled')) { task.status = 'cancelled'; changed = true; continue; }
      if (deps.some((dep) => dep.status === 'failed' || dep.status === 'blocked')) {
        task.status = 'blocked';
        task.result = task.result || 'Une dépendance n’est pas valide. Les tâches indépendantes continuent.';
        changed = true;
        continue;
      }
      if (task.status === 'pending' && deps.every((dep) => dep.status === 'passed')) { task.status = 'ready'; changed = true; }
    }
  }
  return [...map.values()];
}

/** Au plus `concurrency` tâches ready, sans chemin commun et avec une seule opération Git. */
export function scheduleWave(tasks: RuntimeTask[], concurrency: number, held: { paths?: string[]; git?: boolean } = {}): RuntimeTask[] {
  const limit = Math.max(1, Math.min(concurrency, 8));
  const ready = tasks.filter((task) => task.status === 'ready' && task.role !== 'git-manager');
  const chosen: RuntimeTask[] = [];
  const paths = [...(held.paths ?? [])];
  let git = held.git === true;
  for (const task of ready) {
    if (chosen.length >= limit) break;
    if (task.git && git) continue;
    if (task.paths.some((file) => paths.some((ownedPath) => pathsOverlap(file, ownedPath)))) continue;
    chosen.push(task);
    paths.push(...task.paths);
    if (task.git) git = true;
  }
  return chosen;
}

export function buildRuntimeTasks(claims: { agentId: string; paths: string[] }[], isolate: boolean): RuntimeTask[] {
  const architects = claims.filter((claim) => claim.paths.length).map((claim) => ({
    id: id(), key: `architect:${claim.agentId}:${[...claim.paths].sort().join('|')}`, role: 'architect' as const, agentId: claim.agentId,
    title: `Architecte ${claim.agentId}`, status: 'pending' as const, dependsOn: [] as string[], paths: [...claim.paths], git: false, isolate, runs: 0,
  }));
  const roots = architects.length ? architects : [{ id: id(), key: 'architect:none', role: 'architect' as const, agentId: 'architect', title: 'Architecte', status: 'pending' as const, dependsOn: [], paths: [], git: false, isolate: false, runs: 0 }];
  const coder: RuntimeTask = { id: id(), key: 'coder', role: 'coder', agentId: 'coder', title: 'Coder OpenCode', status: 'pending', dependsOn: roots.map((item) => item.id), paths: [...new Set(roots.flatMap((item) => item.paths))], git: false, isolate: false, runs: 0 };
  const tester: RuntimeTask = { id: id(), key: 'tester', role: 'tester', agentId: 'tester', title: 'Tests réels', status: 'pending', dependsOn: [coder.id], paths: [...coder.paths], git: false, isolate: false, runs: 0 };
  const reviewer: RuntimeTask = { id: id(), key: 'reviewer', role: 'reviewer', agentId: 'reviewer', title: 'Revue locale', status: 'pending', dependsOn: [tester.id], paths: [...coder.paths], git: false, isolate: false, runs: 0 };
  const manager: RuntimeTask = { id: id(), key: 'git-manager', role: 'git-manager', agentId: 'git-manager', title: 'Commit, push et PR après accord', status: 'pending', dependsOn: [reviewer.id], paths: [], git: true, isolate: false, runs: 0 };
  return [...roots, coder, tester, reviewer, manager];
}

export async function createTaskWorktree(target: Project, key: string): Promise<string> {
  const safe = key.replace(/[^a-z0-9-]/giu, '').slice(0, 24) || 'task';
  const dest = path.join(path.dirname(target.path), `.cortex-wt-${safe}`);
  await gitOk(target, ['worktree', 'add', '--detach', dest, 'HEAD']);
  return dest;
}

function loadRuntime(ctx: Context, projectId: string, missionId: string): MissionRuntime | undefined {
  return all<MissionRuntime>(ctx, 'runtimes', projectId).find((item) => item.missionId === missionId);
}
function loadMemory(ctx: Context, missionId: string): MissionMemory | undefined {
  const found = ctx.store.get<MissionMemory>('memories', missionId);
  if (!found || found.schemaVersion !== 1) return undefined;
  return found;
}
function saveRuntime(ctx: Context, record: MissionRuntime): MissionRuntime {
  record.updatedAt = now();
  const memory = ctx.store.get<MissionMemory>('memories', record.id);
  if (memory && memory.schemaVersion === 1 && memory.missionId === record.missionId) {
    record.tokens = { input: memory.tokens.input, output: memory.tokens.output };
    record.corrections = memory.corrections.slice(-8);
  } else {
    record.tokens = record.tokens ?? { input: 0, output: 0 };
    record.corrections = record.corrections ?? [];
  }
  return ctx.store.put('runtimes', record, record.projectId);
}
function blankMemory(target: Project, mission: Mission): MissionMemory {
  return {
    id: mission.id, schemaVersion: 1, version: 1, projectId: target.id, missionId: mission.id, objective: mission.goal,
    plan: [], decisions: [], files: [], tests: [], errors: [], corrections: [], checkpoints: [], sessions: [],
    tokens: { input: 0, output: 0, byAgent: {} }, updatedAt: now(),
  };
}
function saveMemory(ctx: Context, memory: MissionMemory, record: MissionRuntime): MissionMemory {
  memory.plan = record.tasks.map((task) => ({ key: task.key, role: task.role, status: task.status }));
  memory.updatedAt = now();
  memory.decisions = memory.decisions.slice(-40).map((item) => ({ ...item, text: redact(ctx, item.text).slice(0, 500) }));
  memory.objective = redact(ctx, memory.objective).slice(0, 4_000);
  memory.errors = memory.errors.slice(-20).map((item) => redact(ctx, item).slice(0, 500));
  return ctx.store.put('memories', memory, memory.projectId);
}
function note(memory: MissionMemory, agent: string, text: string): void {
  memory.decisions.push({ at: now(), agent, text: text.slice(0, 500) });
  memory.checkpoints.push({ at: now(), key: agent, status: 'running' });
}

const runSchema = z.object({
  command: z.string().trim().min(1).max(4_000),
  confirm: z.literal(true),
  instruction: z.string().trim().min(1).max(8_000).optional(),
  maxAttempts: z.number().int().min(1).max(3).optional(),
  budgetMs: z.number().int().min(50).max(600_000).optional(),
  timeoutMs: z.number().int().min(50).max(30_000).optional(),
  testPolicy: z.enum(['deny', 'create', 'adapt']).optional(),
  concurrency: z.number().int().min(1).max(8).optional(),
  through: z.enum(['architect', 'coder', 'reviewer']).optional(),
  isolate: z.boolean().optional(),
}).strict();

export async function runRuntime(ctx: Context, target: Project, missionId: string, input: unknown, options: { driver?: AgentDriver; clock?: () => number; failKeys?: string[] } = {}): Promise<MissionRuntime> {
  confirmed(input); trusted(target);
  const parsed = runSchema.parse(input);
  const body = { ...parsed, maxAttempts: parsed.maxAttempts ?? 3, budgetMs: parsed.budgetMs ?? 180_000, timeoutMs: parsed.timeoutMs ?? 15_000, testPolicy: parsed.testPolicy ?? 'deny' as const, concurrency: parsed.concurrency ?? 2, through: parsed.through ?? 'reviewer' as const, isolate: parsed.isolate ?? false };
  const gate = `${target.id}:${missionId}`;
  if (running.has(gate)) throw new AdvancedError(409, 'RUNTIME_RUNNING', 'Ce runtime est déjà en cours.');
  running.add(gate);
  try {
    const mission = owned<Mission>(ctx, 'missions', missionId, target.id);
    if (mission.status === 'cancelled') throw new AdvancedError(409, 'MISSION_CLOSED', 'Mission annulée.');
    const branchRun = await git(target, ['branch', '--show-current']);
    const branch = branchRun.exitCode === 0 && !branchRun.timedOut && !branchRun.truncated ? branchRun.output.trim() : '';
    if (!branch || isProtectedBranch(branch)) throw new AdvancedError(409, 'PROTECTED_BRANCH', `Le runtime refuse d’écrire sur « ${branch || 'HEAD détaché'} ».`);
    const existing = loadRuntime(ctx, target.id, missionId);
    const record: MissionRuntime = existing ?? {
      id: missionId, projectId: target.id, missionId, status: 'pending', concurrency: body.concurrency, tasks: buildRuntimeTasks(mission.claims, body.isolate),
      activeAgents: [], branch, control: 'run', parallelWaves: 0, pullRequestUrl: null, remoteCertified: false, tokens: { input: 0, output: 0 }, corrections: [], createdAt: now(), updatedAt: now(),
    };
    record.branch = branch;
    record.concurrency = body.concurrency;
    record.control = 'run';
    const memory = loadMemory(ctx, missionId) ?? blankMemory(target, mission);
    if (body.instruction) memory.objective = body.instruction;
    if (mission.conflicts.length || !mission.claims.some((claim) => claim.paths.length)) {
      const reason = mission.conflicts.length ? 'Conflit de fichiers. Aucun modèle.' : 'Périmètre vide. Aucun modèle.';
      record.status = 'blocked';
      record.tasks = record.tasks.map((task) => ({ ...task, status: 'blocked' as const, result: reason }));
      note(memory, 'architect', reason);
      saveMemory(ctx, memory, record);
      return saveRuntime(ctx, record);
    }
    const stop = RANK.indexOf(body.through === 'architect' ? 'architect' : body.through === 'coder' ? 'coder' : 'reviewer');
    record.status = 'running';
    saveRuntime(ctx, record);
    while (record.control === 'run') {
      const latest = loadRuntime(ctx, target.id, missionId);
      if (latest?.control === 'pause') {
        record.control = 'pause';
        record.status = 'paused';
        record.activeAgents = [];
        note(memory, 'runtime', 'Pause demandée. Elle prend effet entre deux tâches, pas au milieu d’un appel modèle.');
        saveMemory(ctx, memory, record);
        return saveRuntime(ctx, record);
      }
      if (latest?.control === 'cancel' || owned<Mission>(ctx, 'missions', missionId, target.id).status === 'cancelled') {
        record.control = 'cancel';
        record.tasks = record.tasks.map((task) => task.status === 'pending' || task.status === 'ready' || task.status === 'running' ? { ...task, status: 'cancelled' as const } : task);
        note(memory, 'runtime', 'Annulation. Aucune publication.');
        saveMemory(ctx, memory, record);
        return saveRuntime(ctx, finish(record));
      }
      record.tasks = markReady(record.tasks);
      const wave = takeWave(target.id, record, branch);
      if (!wave.length) {
        const waiting = scheduleWave(record.tasks, record.concurrency).length > 0;
        if (waiting) {
          record.status = 'blocked';
          record.activeAgents = [];
          note(memory, 'runtime', 'Verrou de fichier ou de branche. Pas d’écriture concurrente sur le même chemin.');
          saveMemory(ctx, memory, record);
          return saveRuntime(ctx, record);
        }
        break;
      }
      if (wave.length > 1) record.parallelWaves += 1;
      for (const task of record.tasks) if (wave.some((item) => item.id === task.id)) { task.status = 'running'; task.startedAt = now(); }
      record.activeAgents = [...new Set(wave.map((task) => task.agentId))];
      saveRuntime(ctx, record);
      try {
        for (const task of wave) if (task.isolate && !task.worktree) {
          const current = record.tasks.find((item) => item.id === task.id);
          if (current) current.worktree = await createTaskWorktree(target, current.key);
        }
        const listed = wave.some((task) => task.role === 'architect') ? await git(target, ['ls-files', '--cached', '--others', '--exclude-standard']) : undefined;
        const map = listed && listed.exitCode === 0 ? listed.output.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 30).join(', ') : '';
        await Promise.all(wave.map((task) => execute(ctx, target, missionId, record, memory, task, body, options, map)));
      } catch (error) {
        for (const task of wave) {
          const current = record.tasks.find((item) => item.id === task.id);
          if (current?.status === 'running') { current.status = 'failed'; current.finishedAt = now(); current.result = redact(ctx, error instanceof Error ? error.message : 'Tâche interrompue.'); }
        }
        note(memory, 'runtime', redact(ctx, error instanceof Error ? error.message : 'Échec.'));
        saveMemory(ctx, memory, record);
        saveRuntime(ctx, finish(record));
        throw error;
      } finally { locks.delete(`${target.id}:${record.id}`); }
      const fresh = owned<Mission>(ctx, 'missions', missionId, target.id);
      const tokens = (fresh.repairs ?? []).reduce((sum, item) => ({ input: sum.input + (item.tokens?.input ?? 0), output: sum.output + (item.tokens?.output ?? 0) }), { input: 0, output: 0 });
      memory.tokens.input = tokens.input;
      memory.tokens.output = tokens.output;
      memory.tokens.byAgent.coder = { ...tokens };
      if (fresh.agentSessionId && !memory.sessions.includes(fresh.agentSessionId)) memory.sessions.push(fresh.agentSessionId);
      memory.files = [...new Set((fresh.repairs ?? []).flatMap((item) => item.applied))];
      const doneThrough = record.tasks.filter((task) => RANK.indexOf(task.role) <= stop && task.role !== 'git-manager').every((task) => task.status === 'passed');
      const pendingAfter = record.tasks.some((task) => RANK.indexOf(task.role) > stop && (task.status === 'pending' || task.status === 'ready'));
      if (doneThrough && pendingAfter) {
        record.status = 'paused';
        record.activeAgents = [];
        note(memory, 'runtime', `Checkpoint ${body.through}. Les tâches passées ne sont pas relancées. Publication non demandée.`);
        saveMemory(ctx, memory, record);
        return saveRuntime(ctx, record);
      }
    }
    saveMemory(ctx, memory, record);
    return saveRuntime(ctx, finish(record));
  } finally { running.delete(gate); }
}

function takeWave(projectId: string, record: MissionRuntime, branch: string): RuntimeTask[] {
  const heldPaths: string[] = [];
  let git = false;
  for (const [key, hold] of locks) {
    if (!key.startsWith(`${projectId}:`) || key.endsWith(`:${record.id}`)) continue;
    heldPaths.push(...hold.paths);
    if (hold.branch === branch) git = true;
  }
  const chosen = scheduleWave(record.tasks, record.concurrency, { paths: heldPaths, git });
  if (chosen.length) locks.set(`${projectId}:${record.id}`, { paths: chosen.flatMap((task) => task.paths), branch: chosen.some((task) => task.git) ? branch : undefined });
  return chosen;
}

function finish(record: MissionRuntime): MissionRuntime {
  record.tasks = markReady(record.tasks);
  if (record.control === 'cancel' || record.tasks.some((task) => task.status === 'cancelled')) record.status = 'cancelled';
  else if (record.tasks.some((task) => task.status === 'failed')) record.status = 'failed';
  else if (record.tasks.some((task) => task.status === 'blocked')) record.status = 'blocked';
  else if (record.tasks.find((task) => task.role === 'reviewer')?.status === 'passed' && record.tasks.find((task) => task.role === 'git-manager')?.status !== 'passed') record.status = 'paused';
  else if (record.tasks.every((task) => task.status === 'passed')) record.status = 'passed';
  else record.status = 'paused';
  record.activeAgents = [];
  return record;
}

async function execute(ctx: Context, target: Project, missionId: string, record: MissionRuntime, memory: MissionMemory, task: RuntimeTask, body: z.infer<typeof runSchema> & { maxAttempts: number; budgetMs: number; timeoutMs: number; testPolicy: 'deny' | 'create' | 'adapt' }, options: { driver?: AgentDriver; clock?: () => number; failKeys?: string[] }, map: string): Promise<void> {
  const current = record.tasks.find((item) => item.id === task.id);
  if (!current || current.status === 'passed') return;
  current.runs += 1;
  if (current.role === 'architect') {
    if (options.failKeys?.includes(current.key)) {
      current.status = 'failed';
      current.finishedAt = now();
      current.result = 'Analyse refusée pour cette tâche. Les tâches indépendantes ne sont pas annulées.';
      memory.errors.push(current.result);
      note(memory, current.agentId, current.result);
      return;
    }
    const mapText = map || 'carte indisponible';
    current.status = 'passed';
    current.finishedAt = now();
    current.result = `Plan local, sans modèle. Périmètre ${current.paths.join(', ') || 'vide'}.`;
    note(memory, current.agentId, `${current.result} Carte : ${mapText}`);
    return;
  }
  if (current.role === 'coder') {
    const view = await runAgentMission(ctx, target, missionId, { command: body.command, confirm: true, maxAttempts: body.maxAttempts, budgetMs: body.budgetMs, timeoutMs: body.timeoutMs, testPolicy: body.testPolicy }, options);
    const stopped = view.repairs?.at(-1)?.stopped;
    if (view.verdict.status === 'cancelled' || stopped === 'cancelled') current.status = 'cancelled';
    else if (view.verdict.complete) current.status = 'passed';
    else if (view.verdict.label === 'BLOCKED' || stopped === 'blocked' || stopped === 'permission' || stopped === 'conflict' || stopped === 'scope' || stopped === 'test-tamper') current.status = 'blocked';
    else current.status = 'failed';
    current.finishedAt = now();
    current.result = `${view.verdict.label ?? view.verdict.status}. ${view.repairs?.at(-1)?.diagnosis ?? ''}`.slice(0, 500);
    for (const repair of view.repairs ?? []) {
      if (repair.applied.length) memory.corrections.push(repair.applied.join(', '));
      if (repair.exitCode !== 0 && repair.diagnosis) memory.errors.push(repair.diagnosis.slice(0, 300));
    }
    note(memory, 'coder', current.result);
    return;
  }
  if (current.role === 'tester') {
    const mission = presentMission(owned<Mission>(ctx, 'missions', missionId, target.id));
    const latest = mission.evidence.at(-1);
    if (latest && latest.exitCode === 0 && !latest.timedOut && !latest.truncated) {
      current.status = 'passed';
      current.finishedAt = now();
      current.result = `Preuve déjà valide (${latest.commandId}), non relancée.`;
      memory.tests.push({ command: latest.command, exitCode: 0, at: now() });
      note(memory, 'tester', current.result);
      return;
    }
    const ran = await runCommand(ctx, target, { command: body.command, confirm: true, kind: 'test', timeoutMs: body.timeoutMs });
    const fresh = owned<Mission>(ctx, 'missions', missionId, target.id);
    fresh.evidence.push({ id: id(), commandId: ran.id, command: ran.command, exitCode: ran.exitCode, timedOut: ran.timedOut, truncated: ran.truncated, createdAt: ran.createdAt });
    storeMission(ctx, fresh);
    current.status = ran.exitCode === 0 && !ran.timedOut && !ran.truncated ? 'passed' : 'failed';
    current.finishedAt = now();
    current.result = `Test exit ${ran.exitCode}.`;
    memory.tests.push({ command: ran.command, exitCode: ran.exitCode, at: now() });
    note(memory, 'tester', current.result);
    return;
  }
  if (current.role === 'reviewer') {
    const mission = presentMission(owned<Mission>(ctx, 'missions', missionId, target.id));
    const applied = [...new Set((mission.repairs ?? []).flatMap((item) => item.applied))];
    const outside = applied.filter((file) => !pathInScope(file, mission.claims));
    const proven = mission.verdict.complete && !outside.length;
    current.status = proven ? 'passed' : 'failed';
    current.finishedAt = now();
    current.result = proven ? `Revue acceptée : ${applied.join(', ') || 'aucun fichier'}.` : `Revue refusée. Hors périmètre : ${outside.join(', ') || 'aucun'}.`;
    note(memory, 'reviewer', current.result);
  }
}

const publishSchema = z.object({
  confirm: z.literal(true),
  message: z.string().trim().min(1).max(500),
  base: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(16_000).optional(),
  allowCommit: z.literal(true).optional(),
  allowPush: z.literal(true).optional(),
  allowPullRequest: z.literal(true).optional(),
}).strict();

export async function publishRuntime(ctx: Context, target: Project, missionId: string, input: unknown): Promise<MissionRuntime> {
  confirmed(input); trusted(target);
  const parsed = publishSchema.parse(input);
  const body = { ...parsed, base: parsed.base ?? 'main' };
  if (!body.allowCommit && !body.allowPush && !body.allowPullRequest) throw new AdvancedError(403, 'PUBLISH_PERMISSION', 'Commit, push et pull request exigent chacun leur permission.');
  const mission = presentMission(owned<Mission>(ctx, 'missions', missionId, target.id));
  if (!mission.verdict.complete) throw new AdvancedError(409, 'MISSION_NOT_PROVEN', 'Mission non prouvée. Publication refusée.');
  const record = loadRuntime(ctx, target.id, missionId);
  if (!record) throw new AdvancedError(409, 'RUNTIME_REQUIRED', 'Runtime absent.');
  if (record.status === 'cancelled') throw new AdvancedError(409, 'MISSION_CLOSED', 'Mission annulée.');
  const manager = record.tasks.find((task) => task.role === 'git-manager');
  if (!manager || record.tasks.find((task) => task.role === 'reviewer')?.status !== 'passed') throw new AdvancedError(409, 'REVIEW_REQUIRED', 'La revue n’est pas acceptée.');
  const memory = loadMemory(ctx, missionId) ?? blankMemory(target, owned<Mission>(ctx, 'missions', missionId, target.id));
  const applied = [...new Set((mission.repairs ?? []).flatMap((item) => item.applied))];
  const branch = (await gitOk(target, ['branch', '--show-current'])).trim();
  const busy = [...locks.entries()].some(([key, hold]) => key.startsWith(`${target.id}:`) && (hold.branch === branch || applied.some((file) => hold.paths.some((ownedPath) => pathsOverlap(file, ownedPath)))));
  if (busy) throw new AdvancedError(409, 'BRANCH_BUSY', 'Git ou un fichier du périmètre est déjà tenu.');
  locks.set(`${target.id}:${record.id}`, { paths: applied, branch });
  manager.status = 'running';
  manager.runs += 1;
  try {
    if (body.allowCommit) {
      if (!applied.length) throw new AdvancedError(409, 'COMMIT_SCOPE', 'Aucun fichier de correctif à committer.');
      const dirty = await git(target, ['status', '--porcelain=v1', '--', ...applied]);
      if (dirty.exitCode === 0 && dirty.output.trim()) {
        await commitPaths(ctx, target, { message: body.message, paths: applied, confirm: true, allowCommit: true });
        note(memory, 'git-manager', `Commit autorisé : ${applied.join(', ')}.`);
      } else note(memory, 'git-manager', 'Commit déjà présent, non refait.');
    }
    if (body.allowPush) {
      await pushFeatureBranch(ctx, target, { confirm: true, allowPush: true });
      note(memory, 'git-manager', `Push autorisé sur ${branch}, sans --force.`);
    }
    if (body.allowPullRequest) {
      const opened = await openPullRequest(ctx, target, { base: body.base, title: body.title || body.message, body: body.body || memory.decisions.map((item) => `${item.agent}: ${item.text}`).join('\n').slice(0, 8_000), confirm: true, allowPullRequest: true });
      record.pullRequestUrl = opened.url;
      record.remoteCertified = opened.remoteCertified;
      note(memory, 'git-manager', `PR certifiée=${opened.remoteCertified} ${opened.url ?? ''}`);
    }
    manager.status = 'passed';
    manager.finishedAt = now();
    manager.result = `commit=${body.allowCommit === true} push=${body.allowPush === true} pr=${body.allowPullRequest === true} certifié=${record.remoteCertified}`;
    record.status = 'passed';
  } catch (error) {
    manager.status = 'failed';
    manager.result = redact(ctx, error instanceof Error ? error.message : 'Publication refusée.');
    record.status = 'failed';
    note(memory, 'git-manager', manager.result);
    saveMemory(ctx, memory, record);
    saveRuntime(ctx, record);
    throw error;
  } finally { locks.delete(`${target.id}:${record.id}`); }
  saveMemory(ctx, memory, record);
  return saveRuntime(ctx, record);
}

export function pauseRuntime(ctx: Context, target: Project, missionId: string, input: unknown): MissionRuntime {
  confirmed(input); trusted(target);
  z.object({ confirm: z.literal(true) }).strict().parse(input);
  const mission = owned<Mission>(ctx, 'missions', missionId, target.id);
  const record = loadRuntime(ctx, target.id, missionId) ?? {
    id: missionId, projectId: target.id, missionId, status: 'paused' as const, concurrency: 2, tasks: buildRuntimeTasks(mission.claims, false),
    activeAgents: [], branch: '', control: 'pause' as const, parallelWaves: 0, pullRequestUrl: null, remoteCertified: false, tokens: { input: 0, output: 0 }, corrections: [], createdAt: now(), updatedAt: now(),
  };
  record.control = 'pause';
  if (record.status !== 'running') record.status = 'paused';
  const memory = loadMemory(ctx, missionId) ?? blankMemory(target, mission);
  note(memory, 'runtime', 'Pause enregistrée. Elle ne coupe pas un appel modèle déjà lancé.');
  saveMemory(ctx, memory, record);
  return saveRuntime(ctx, record);
}

export function cancelRuntime(ctx: Context, target: Project, missionId: string, input: unknown): MissionRuntime {
  confirmed(input); trusted(target);
  cancelMission(ctx, target, missionId, { confirm: true });
  const mission = owned<Mission>(ctx, 'missions', missionId, target.id);
  const record = loadRuntime(ctx, target.id, missionId) ?? {
    id: missionId, projectId: target.id, missionId, status: 'cancelled' as const, concurrency: 2, tasks: buildRuntimeTasks(mission.claims, false),
    activeAgents: [], branch: '', control: 'cancel' as const, parallelWaves: 0, pullRequestUrl: null, remoteCertified: false, tokens: { input: 0, output: 0 }, corrections: [], createdAt: now(), updatedAt: now(),
  };
  record.control = 'cancel';
  record.status = 'cancelled';
  record.tasks = record.tasks.map((task) => task.status === 'pending' || task.status === 'ready' || task.status === 'running' ? { ...task, status: 'cancelled' as const } : task);
  const memory = loadMemory(ctx, missionId) ?? blankMemory(target, mission);
  note(memory, 'runtime', 'Runtime annulé. Aucune publication.');
  saveMemory(ctx, memory, record);
  return saveRuntime(ctx, record);
}

export function invalidateRuntime(ctx: Context, target: Project, missionId: string, input: unknown): MissionRuntime {
  confirmed(input); trusted(target);
  const body = z.object({ confirm: z.literal(true), keys: z.array(z.string().min(1).max(200)).min(1).max(20) }).strict().parse(input);
  const record = loadRuntime(ctx, target.id, missionId);
  if (!record) throw new AdvancedError(409, 'RUNTIME_REQUIRED', 'Runtime absent.');
  const doomed = new Set(body.keys);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of record.tasks) {
      if (doomed.has(task.key)) continue;
      if (task.dependsOn.some((dep) => doomed.has(record.tasks.find((item) => item.id === dep)?.key ?? ''))) { doomed.add(task.key); changed = true; }
    }
  }
  for (const task of record.tasks) {
    if (!doomed.has(task.key)) continue;
    task.status = 'pending';
    task.result = 'Invalidée explicitement.';
    task.finishedAt = undefined;
  }
  const memory = loadMemory(ctx, missionId) ?? blankMemory(target, owned<Mission>(ctx, 'missions', missionId, target.id));
  memory.version += 1;
  memory.checkpoints.push({ at: now(), key: `invalidate:${[...doomed].join(',')}`, status: 'pending' });
  note(memory, 'runtime', `Invalidation explicite : ${[...doomed].join(', ')}.`);
  saveMemory(ctx, memory, record);
  return saveRuntime(ctx, record);
}

export function registerRuntimeRoutes(app: Express, ctx: Context): void {
  const base = '/api/projects/:id/missions/:missionId/runtime';
  app.get('/api/projects/:id/runtimes', route(ctx, (req, res) => res.json(all<MissionRuntime>(ctx, 'runtimes', project(ctx, req).id))));
  app.get(`${base}/memory`, route(ctx, (req, res) => {
    const missionId = param(req, 'missionId');
    const memory = loadMemory(ctx, missionId);
    if (!memory || memory.projectId !== project(ctx, req).id) throw new AdvancedError(404, 'MEMORY_NOT_FOUND', 'Mémoire absente.');
    res.json(memory);
  }));
  app.post(base, route(ctx, async (req, res) => res.json(await runRuntime(ctx, project(ctx, req), param(req, 'missionId'), req.body))));
  app.post(`${base}/pause`, route(ctx, (req, res) => res.json(pauseRuntime(ctx, project(ctx, req), param(req, 'missionId'), req.body))));
  app.post(`${base}/resume`, route(ctx, async (req, res) => res.json(await runRuntime(ctx, project(ctx, req), param(req, 'missionId'), req.body))));
  app.post(`${base}/cancel`, route(ctx, (req, res) => res.json(cancelRuntime(ctx, project(ctx, req), param(req, 'missionId'), req.body))));
  app.post(`${base}/invalidate`, route(ctx, (req, res) => res.json(invalidateRuntime(ctx, project(ctx, req), param(req, 'missionId'), req.body))));
  app.post(`${base}/publish`, route(ctx, async (req, res) => res.json(await publishRuntime(ctx, project(ctx, req), param(req, 'missionId'), req.body))));
}
