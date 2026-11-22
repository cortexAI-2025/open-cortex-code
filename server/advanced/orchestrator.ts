import type { Express } from 'express';
import { z } from 'zod';
import type { Project } from '../../shared/contracts.js';
import { AdvancedError, type Context, all, confirmed, id, now, owned, param, project, redact, route, trusted } from './common.js';
import type { FileClaim } from './conflicts.js';
import { commitPaths, isProtectedBranch, openPullRequest, pushFeatureBranch } from './git-publish.js';
import { cancelMission, presentMission, storeMission, type Mission } from './mission.js';
import { git, runCommand } from './process.js';
import { runAgentMission, type AgentDriver } from './agent-mission.js';
import { pathInScope } from './repair.js';

export type TaskStatus = 'pending' | 'running' | 'blocked' | 'failed' | 'completed' | 'cancelled';
export type OrchestratorRole = 'planner' | 'coder' | 'tester' | 'reviewer' | 'publisher';
export interface OrchestratorTask {
  id: string;
  key: string;
  role: OrchestratorRole;
  title: string;
  status: TaskStatus;
  dependsOn: string[];
  paths: string[];
  git: boolean;
  runs: number;
  result?: string;
}
export interface OrchestratorDecision { at: string; role: string; text: string }
export interface MissionOrchestration {
  id: string;
  projectId: string;
  missionId: string;
  instruction: string;
  status: 'pending' | 'running' | 'paused' | 'blocked' | 'failed' | 'completed' | 'cancelled';
  tasks: OrchestratorTask[];
  decisions: OrchestratorDecision[];
  activeRole: string | null;
  branch: string;
  tokens: { input: number; output: number };
  cost: { currency: 'USD'; amount: number } | null;
  pullRequestUrl: string | null;
  remoteCertified: boolean;
  control: 'run' | 'pause' | 'cancel';
  createdAt: string;
  updatedAt: string;
}

const pauseFlags = new Set<string>();
const running = new Set<string>();
const locks = new Map<string, { paths: string[]; branch?: string }>();

export function pathsOverlap(left: string, right: string): boolean {
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** Tâches prêtes dont les fichiers ne se chevauchent pas. Une seule tâche Git à la fois. */
export function selectRunnable(tasks: OrchestratorTask[], held: { paths?: string[]; git?: boolean } = {}): OrchestratorTask[] {
  const ready = tasks.filter((task) => task.status === 'pending' && task.dependsOn.every((dep) => tasks.find((item) => item.id === dep)?.status === 'completed'));
  const chosen: OrchestratorTask[] = [];
  const paths = [...(held.paths ?? [])];
  let git = held.git === true;
  for (const task of ready) {
    if (task.git && git) continue;
    if (task.paths.some((file) => paths.some((ownedPath) => pathsOverlap(file, ownedPath)))) continue;
    chosen.push(task);
    paths.push(...task.paths);
    if (task.git) git = true;
  }
  return chosen;
}

export function propagate(tasks: OrchestratorTask[]): OrchestratorTask[] {
  const map = new Map(tasks.map((task) => [task.id, { ...task }]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of map.values()) {
      if (task.status !== 'pending') continue;
      const deps = task.dependsOn.map((dep) => map.get(dep)).filter((item): item is OrchestratorTask => !!item);
      if (deps.some((dep) => dep.status === 'cancelled')) { task.status = 'cancelled'; changed = true; }
      else if (deps.some((dep) => dep.status === 'failed' || dep.status === 'blocked')) {
        task.status = 'blocked';
        task.result = task.result || 'Dépendance non satisfaite. Aucune publication automatique.';
        changed = true;
      }
    }
  }
  return [...map.values()];
}

export function buildOrchestratorTasks(claims: FileClaim[]): OrchestratorTask[] {
  const groups = claims.filter((claim) => claim.paths.length).map((claim) => ({
    id: id(),
    key: `planner:${claim.agentId}:${[...claim.paths].sort().join('|')}`,
    role: 'planner' as const,
    title: `Analyser ${claim.agentId}`,
    status: 'pending' as const,
    dependsOn: [] as string[],
    paths: [...claim.paths],
    git: false,
    runs: 0,
  }));
  const planners = groups.length ? groups : [{ id: id(), key: 'planner:none', role: 'planner' as const, title: 'Analyser le dépôt', status: 'pending' as const, dependsOn: [], paths: [], git: false, runs: 0 }];
  const coder: OrchestratorTask = { id: id(), key: 'coder', role: 'coder', title: 'Modifier le périmètre avec OpenCode', status: 'pending', dependsOn: planners.map((item) => item.id), paths: [...new Set(planners.flatMap((item) => item.paths))], git: false, runs: 0 };
  const tester: OrchestratorTask = { id: id(), key: 'tester', role: 'tester', title: 'Lire ou exécuter la preuve de test', status: 'pending', dependsOn: [coder.id], paths: [...coder.paths], git: false, runs: 0 };
  const reviewer: OrchestratorTask = { id: id(), key: 'reviewer', role: 'reviewer', title: 'Revue locale du diff et du périmètre', status: 'pending', dependsOn: [tester.id], paths: [...coder.paths], git: false, runs: 0 };
  const publisher: OrchestratorTask = { id: id(), key: 'publisher', role: 'publisher', title: 'Commit, push et PR seulement après accord', status: 'pending', dependsOn: [reviewer.id], paths: [], git: true, runs: 0 };
  return [...planners, coder, tester, reviewer, publisher];
}

function note(record: MissionOrchestration, role: string, text: string): void {
  record.decisions.push({ at: now(), role, text: text.slice(0, 500) });
  if (record.decisions.length > 40) record.decisions.splice(0, record.decisions.length - 40);
}

function save(ctx: Context, record: MissionOrchestration): MissionOrchestration {
  record.updatedAt = now();
  record.decisions = record.decisions.map((item) => ({ ...item, text: redact(ctx, item.text).slice(0, 500) }));
  return ctx.store.put('orchestrations', record, record.projectId);
}

function load(ctx: Context, projectId: string, missionId: string): MissionOrchestration | undefined {
  return all<MissionOrchestration>(ctx, 'orchestrations', projectId).find((item) => item.missionId === missionId);
}

function externalHold(projectId: string, orchestrationId: string, branch: string): { paths: string[]; git: boolean } {
  const paths: string[] = [];
  let git = false;
  for (const [key, hold] of locks) {
    if (!key.startsWith(`${projectId}:`) || key.endsWith(`:${orchestrationId}`)) continue;
    paths.push(...hold.paths);
    if (hold.branch === branch) git = true;
  }
  return { paths, git };
}

function acquire(projectId: string, orchestrationId: string, branch: string, tasks: OrchestratorTask[]): OrchestratorTask[] {
  const held = externalHold(projectId, orchestrationId, branch);
  const chosen = selectRunnable(tasks.filter((task) => task.role !== 'publisher'), held);
  if (chosen.length) locks.set(`${projectId}:${orchestrationId}`, { paths: chosen.flatMap((task) => task.paths), branch: chosen.some((task) => task.git) ? branch : undefined });
  return chosen;
}

function release(projectId: string, orchestrationId: string): void {
  locks.delete(`${projectId}:${orchestrationId}`);
}

async function repoMap(target: Project): Promise<string> {
  const listed = await git(target, ['ls-files', '--cached', '--others', '--exclude-standard']);
  if (listed.exitCode !== 0 || listed.timedOut || listed.truncated) return 'Carte Git indisponible.';
  return listed.output.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 40).join('\n') || '(aucun fichier)';
}

function finish(record: MissionOrchestration): MissionOrchestration {
  record.tasks = propagate(record.tasks);
  if (record.control === 'cancel' || record.tasks.some((task) => task.status === 'cancelled')) record.status = 'cancelled';
  else if (record.tasks.some((task) => task.status === 'failed')) record.status = 'failed';
  else if (record.tasks.some((task) => task.status === 'blocked')) record.status = 'blocked';
  else if (record.tasks.find((task) => task.role === 'reviewer')?.status === 'completed' && record.tasks.find((task) => task.role === 'publisher')?.status !== 'completed') record.status = 'paused';
  else if (record.tasks.every((task) => task.status === 'completed')) record.status = 'completed';
  else record.status = 'paused';
  record.activeRole = null;
  return record;
}

const runSchema = z.object({
  command: z.string().trim().min(1).max(4_000),
  confirm: z.literal(true),
  instruction: z.string().trim().min(1).max(8_000).optional(),
  maxAttempts: z.number().int().min(1).max(3).default(3),
  budgetMs: z.number().int().min(50).max(600_000).default(180_000),
  timeoutMs: z.number().int().min(50).max(30_000).default(15_000),
  testPolicy: z.enum(['deny', 'create', 'adapt']).default('deny'),
  through: z.enum(['planner', 'coder', 'reviewer']).default('reviewer'),
}).strict();

export async function runOrchestrator(ctx: Context, target: Project, missionId: string, input: unknown, options: { driver?: AgentDriver; clock?: () => number } = {}): Promise<MissionOrchestration> {
  confirmed(input); trusted(target);
  const parsed = runSchema.parse(input);
  const body = {
    ...parsed,
    maxAttempts: parsed.maxAttempts ?? 3,
    budgetMs: parsed.budgetMs ?? 180_000,
    timeoutMs: parsed.timeoutMs ?? 15_000,
    testPolicy: parsed.testPolicy ?? 'deny' as const,
    through: parsed.through ?? 'reviewer' as const,
  };
  const gate = `${target.id}:${missionId}`;
  if (running.has(gate)) throw new AdvancedError(409, 'ORCHESTRATION_RUNNING', 'Cette mission est déjà en cours. Pas de second modèle ni de second Git.');
  running.add(gate);
  try {
  const mission = owned<Mission>(ctx, 'missions', missionId, target.id);
  if (mission.status === 'cancelled') throw new AdvancedError(409, 'MISSION_CLOSED', 'Mission annulée.');
  const branchRun = await git(target, ['branch', '--show-current']);
  const branch = branchRun.exitCode === 0 && !branchRun.timedOut && !branchRun.truncated ? branchRun.output.trim() : '';
  if (!branch || isProtectedBranch(branch)) throw new AdvancedError(409, 'PROTECTED_BRANCH', `L’orchestrateur refuse d’écrire sur « ${branch || 'HEAD détaché'} ».`);
  const existing = load(ctx, target.id, missionId);
  const record: MissionOrchestration = existing ?? {
    id: missionId, projectId: target.id, missionId, instruction: redact(ctx, body.instruction || mission.goal), status: 'pending',
    tasks: buildOrchestratorTasks(mission.claims), decisions: [], activeRole: null, branch, tokens: { input: 0, output: 0 }, cost: null,
    pullRequestUrl: null, remoteCertified: false, control: 'run', createdAt: now(), updatedAt: now(),
  };
  record.branch = branch;
  record.instruction = redact(ctx, body.instruction || record.instruction || mission.goal);
  record.control = 'run';
  pauseFlags.delete(missionId);
  if (mission.conflicts.length || !mission.claims.some((claim) => claim.paths.length)) {
    const reason = mission.conflicts.length ? 'Conflit de fichiers. Aucun modèle.' : 'Périmètre vide. Aucun modèle.';
    record.status = 'blocked';
    record.tasks = record.tasks.map((task) => ({ ...task, status: 'blocked' as const, result: reason }));
    note(record, 'orchestrator', reason);
    return save(ctx, record);
  }
  const rank = (role: string) => ['planner', 'coder', 'tester', 'reviewer', 'publisher'].indexOf(role);
  const stop = rank(body.through);
  record.status = 'running';
  save(ctx, record);
  while (record.control === 'run') {
    if (pauseFlags.has(missionId)) {
      record.control = 'pause';
      record.status = 'paused';
      record.activeRole = null;
      note(record, 'orchestrator', 'Pause demandée. Les étapes déjà validées ne seront pas refaites.');
      return save(ctx, record);
    }
    if (owned<Mission>(ctx, 'missions', missionId, target.id).status === 'cancelled') {
      record.control = 'cancel';
      record.tasks = record.tasks.map((task) => task.status === 'pending' || task.status === 'running' ? { ...task, status: 'cancelled' as const } : task);
      note(record, 'orchestrator', 'Annulation. Aucune publication.');
      return save(ctx, finish(record));
    }
    record.tasks = propagate(record.tasks);
    const wave = acquire(target.id, record.id, branch, record.tasks);
    if (!wave.length) {
      const runnable = selectRunnable(record.tasks.filter((task) => task.role !== 'publisher')).length > 0;
      if (runnable) {
        record.status = 'blocked';
        record.activeRole = null;
        note(record, 'orchestrator', 'Verrou de fichier ou de branche. Pas d’exécution concurrente sur la même ressource.');
        return save(ctx, record);
      }
      break;
    }
    for (const task of record.tasks) if (wave.some((item) => item.id === task.id)) task.status = 'running';
    record.activeRole = wave.map((task) => task.role).join('+');
    save(ctx, record);
    try {
      const map = wave.some((task) => task.role === 'planner') ? await repoMap(target) : '';
      await Promise.all(wave.map((task) => execute(ctx, target, missionId, record, task, body, options, map)));
    } catch (error) {
      for (const task of wave) {
        const current = record.tasks.find((item) => item.id === task.id);
        if (current?.status === 'running') { current.status = 'failed'; current.result = redact(ctx, error instanceof Error ? error.message : 'Étape interrompue.'); }
      }
      note(record, 'orchestrator', redact(ctx, error instanceof Error ? error.message : 'Échec d’étape.'));
      save(ctx, finish(record));
      throw error;
    } finally { release(target.id, record.id); }
    const fresh = owned<Mission>(ctx, 'missions', missionId, target.id);
    const tokens = (fresh.repairs ?? []).reduce((sum, item) => ({ input: sum.input + (item.tokens?.input ?? 0), output: sum.output + (item.tokens?.output ?? 0) }), { input: 0, output: 0 });
    record.tokens = tokens;
    const doneThrough = record.tasks.filter((task) => rank(task.role) <= stop && task.role !== 'publisher').every((task) => task.status === 'completed');
    const pendingAfter = record.tasks.some((task) => rank(task.role) > stop && task.status === 'pending');
    if (doneThrough && pendingAfter) {
      record.status = 'paused';
      record.activeRole = null;
      note(record, 'orchestrator', `Checkpoint ${body.through}. Les étapes validées ne sont pas relancées. Publication non demandée.`);
      return save(ctx, record);
    }
  }
  return save(ctx, finish(record));
  } finally { running.delete(gate); }
}

async function execute(ctx: Context, target: Project, missionId: string, record: MissionOrchestration, task: OrchestratorTask, body: z.infer<typeof runSchema>, options: { driver?: AgentDriver; clock?: () => number }, map: string): Promise<void> {
  const current = record.tasks.find((item) => item.id === task.id);
  if (!current || current.runs > 0 && current.status === 'completed') return;
  current.runs += 1;
  if (current.role === 'planner') {
    current.status = 'completed';
    current.result = `Analyse locale, sans modèle. Périmètre ${current.paths.join(', ') || 'vide'}.`;
    note(record, 'planner', `${current.result} Carte : ${map.split('\n').slice(0, 8).join(', ')}`);
    return;
  }
  if (current.role === 'coder') {
    const view = await runAgentMission(ctx, target, missionId, { command: body.command, confirm: true, maxAttempts: body.maxAttempts, budgetMs: body.budgetMs, timeoutMs: body.timeoutMs, testPolicy: body.testPolicy }, options);
    const stopped = view.repairs?.at(-1)?.stopped;
    if (view.verdict.status === 'cancelled' || stopped === 'cancelled') current.status = 'cancelled';
    else if (view.verdict.complete) current.status = 'completed';
    else if (view.verdict.label === 'BLOCKED' || stopped === 'blocked' || stopped === 'permission' || stopped === 'conflict' || stopped === 'scope' || stopped === 'test-tamper') current.status = 'blocked';
    else current.status = 'failed';
    current.result = `${view.verdict.label ?? view.verdict.status}. ${view.repairs?.at(-1)?.diagnosis ?? ''}`.slice(0, 500);
    note(record, 'coder', current.result);
    return;
  }
  if (current.role === 'tester') {
    const mission = presentMission(owned<Mission>(ctx, 'missions', missionId, target.id));
    const latest = mission.evidence.at(-1);
    if (latest && latest.exitCode === 0 && !latest.timedOut && !latest.truncated) {
      current.status = 'completed';
      current.result = `Preuve déjà validée (${latest.commandId}), non relancée.`;
      note(record, 'tester', current.result);
      return;
    }
    const ran = await runCommand(ctx, target, { command: body.command, confirm: true, kind: 'test', timeoutMs: body.timeoutMs });
    const fresh = owned<Mission>(ctx, 'missions', missionId, target.id);
    fresh.evidence.push({ id: id(), commandId: ran.id, command: ran.command, exitCode: ran.exitCode, timedOut: ran.timedOut, truncated: ran.truncated, createdAt: ran.createdAt });
    storeMission(ctx, fresh);
    current.status = ran.exitCode === 0 && !ran.timedOut && !ran.truncated ? 'completed' : 'failed';
    current.result = `Test exit ${ran.exitCode}.`;
    note(record, 'tester', current.result);
    return;
  }
  if (current.role === 'reviewer') {
    const mission = presentMission(owned<Mission>(ctx, 'missions', missionId, target.id));
    const applied = [...new Set((mission.repairs ?? []).flatMap((item) => item.applied))];
    const outside = applied.filter((file) => !pathInScope(file, mission.claims));
    const latest = mission.evidence.at(-1);
    const proven = mission.verdict.complete && !outside.length;
    current.status = proven ? 'completed' : 'failed';
    current.result = proven ? `Revue locale acceptée : ${applied.join(', ') || 'aucun fichier'}.` : `Revue refusée. Hors périmètre : ${outside.join(', ') || 'aucun'}. Dernier test exit ${latest?.exitCode ?? 'absent'}.`;
    note(record, 'reviewer', current.result);
  }
}

const publishSchema = z.object({
  confirm: z.literal(true),
  message: z.string().trim().min(1).max(500),
  base: z.string().trim().min(1).max(200).default('main'),
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(16_000).optional(),
  allowCommit: z.literal(true).optional(),
  allowPush: z.literal(true).optional(),
  allowPullRequest: z.literal(true).optional(),
}).strict();

export async function publishOrchestration(ctx: Context, target: Project, missionId: string, input: unknown): Promise<MissionOrchestration> {
  confirmed(input); trusted(target);
  const body = publishSchema.parse(input);
  if (!body.allowCommit && !body.allowPush && !body.allowPullRequest) throw new AdvancedError(403, 'PUBLISH_PERMISSION', 'Commit, push et pull request exigent chacun leur permission. Aucune publication implicite.');
  const mission = presentMission(owned<Mission>(ctx, 'missions', missionId, target.id));
  if (!mission.verdict.complete) throw new AdvancedError(409, 'MISSION_NOT_PROVEN', 'Mission non prouvée. Rapport conservé, publication refusée.');
  const record = load(ctx, target.id, missionId);
  if (!record) throw new AdvancedError(409, 'ORCHESTRATION_REQUIRED', 'Orchestration absente. Aucune publication.');
  if (record.status === 'cancelled' || mission.status === 'cancelled') throw new AdvancedError(409, 'MISSION_CLOSED', 'Mission annulée.');
  const publisher = record.tasks.find((task) => task.role === 'publisher');
  if (!publisher) throw new AdvancedError(409, 'ORCHESTRATION_REQUIRED', 'Tâche de publication absente.');
  if (record.tasks.find((task) => task.role === 'reviewer')?.status !== 'completed') throw new AdvancedError(409, 'REVIEW_REQUIRED', 'La revue locale n’est pas acceptée. Publication refusée.');
  const applied = [...new Set((mission.repairs ?? []).flatMap((item) => item.applied))];
  const branchRun = await git(target, ['branch', '--show-current']);
  const branch = branchRun.output.trim();
  const busy = [...locks.entries()].some(([key, hold]) => key.startsWith(`${target.id}:`) && (hold.branch === branch || applied.some((file) => hold.paths.some((ownedPath) => pathsOverlap(file, ownedPath)))));
  if (busy) throw new AdvancedError(409, 'BRANCH_BUSY', 'Une opération Git ou un fichier du périmètre est déjà tenu. Publication refusée.');
  locks.set(`${target.id}:${record.id}`, { paths: applied, branch });
  publisher.status = 'running';
  publisher.runs += 1;
  record.activeRole = 'publisher';
  try {
    const applied = [...new Set((mission.repairs ?? []).flatMap((item) => item.applied))];
    if (body.allowCommit) {
      if (!applied.length) throw new AdvancedError(409, 'COMMIT_SCOPE', 'Aucun fichier de correctif à committer.');
      const dirty = await git(target, ['status', '--porcelain=v1', '--', ...applied]);
      if (dirty.exitCode === 0 && dirty.output.trim()) {
        await commitPaths(ctx, target, { message: body.message, paths: applied, confirm: true, allowCommit: true });
        note(record, 'publisher', `Commit autorisé : ${applied.join(', ')}.`);
      } else note(record, 'publisher', 'Commit déjà présent, non refait.');
    }
    if (body.allowPush) {
      await pushFeatureBranch(ctx, target, { confirm: true, allowPush: true });
      note(record, 'publisher', `Push autorisé sur ${branch}, sans --force.`);
    }
    if (body.allowPullRequest) {
      const opened = await openPullRequest(ctx, target, { base: body.base, title: body.title || body.message, body: body.body || record.decisions.map((item) => `${item.role}: ${item.text}`).join('\n').slice(0, 8_000), confirm: true, allowPullRequest: true });
      record.pullRequestUrl = opened.url;
      record.remoteCertified = opened.remoteCertified;
      note(record, 'publisher', `PR ${opened.state ?? 'non confirmée'} certifiée=${opened.remoteCertified} ${opened.url ?? ''}`);
    }
    publisher.status = 'completed';
    publisher.result = `commit=${body.allowCommit === true} push=${body.allowPush === true} pr=${body.allowPullRequest === true} certifié=${record.remoteCertified}`;
    record.status = 'completed';
    const fresh = owned<Mission>(ctx, 'missions', missionId, target.id);
    const step = fresh.steps.find((item) => item.kind === 'publish');
    if (step && record.remoteCertified) step.status = 'done';
    storeMission(ctx, fresh);
  } catch (error) {
    publisher.status = 'failed';
    publisher.result = redact(ctx, error instanceof Error ? error.message : 'Publication refusée.');
    record.status = 'failed';
    note(record, 'publisher', publisher.result);
    save(ctx, record);
    throw error;
  } finally {
    release(target.id, record.id);
    record.activeRole = null;
  }
  return save(ctx, record);
}

export function pauseOrchestrator(ctx: Context, target: Project, missionId: string, input: unknown): MissionOrchestration {
  confirmed(input); trusted(target);
  z.object({ confirm: z.literal(true) }).strict().parse(input);
  pauseFlags.add(missionId);
  const mission = owned<Mission>(ctx, 'missions', missionId, target.id);
  const record = load(ctx, target.id, missionId) ?? {
    id: missionId, projectId: target.id, missionId, instruction: mission.goal, status: 'paused' as const, tasks: buildOrchestratorTasks(mission.claims),
    decisions: [], activeRole: null, branch: '', tokens: { input: 0, output: 0 }, cost: null, pullRequestUrl: null, remoteCertified: false, control: 'pause' as const, createdAt: now(), updatedAt: now(),
  };
  record.control = 'pause';
  if (record.status !== 'running') record.status = 'paused';
  note(record, 'orchestrator', 'Pause enregistrée. Elle prend effet entre deux étapes.');
  return save(ctx, record);
}

export function cancelOrchestrator(ctx: Context, target: Project, missionId: string, input: unknown): MissionOrchestration {
  confirmed(input); trusted(target);
  pauseFlags.delete(missionId);
  cancelMission(ctx, target, missionId, { confirm: true });
  const mission = owned<Mission>(ctx, 'missions', missionId, target.id);
  const record = load(ctx, target.id, missionId) ?? {
    id: missionId, projectId: target.id, missionId, instruction: mission.goal, status: 'cancelled' as const, tasks: buildOrchestratorTasks(mission.claims),
    decisions: [], activeRole: null, branch: '', tokens: { input: 0, output: 0 }, cost: null, pullRequestUrl: null, remoteCertified: false, control: 'cancel' as const, createdAt: now(), updatedAt: now(),
  };
  record.control = 'cancel';
  record.status = 'cancelled';
  record.tasks = record.tasks.map((task) => task.status === 'pending' || task.status === 'running' ? { ...task, status: 'cancelled' as const } : task);
  note(record, 'orchestrator', 'Orchestration annulée. Aucune publication.');
  return save(ctx, record);
}

export function registerOrchestratorRoutes(app: Express, ctx: Context): void {
  const base = '/api/projects/:id/missions/:missionId/orchestrate';
  app.get('/api/projects/:id/orchestrations', route(ctx, (req, res) => res.json(all<MissionOrchestration>(ctx, 'orchestrations', project(ctx, req).id))));
  app.post(base, route(ctx, async (req, res) => res.json(await runOrchestrator(ctx, project(ctx, req), param(req, 'missionId'), req.body))));
  app.post(`${base}/pause`, route(ctx, (req, res) => res.json(pauseOrchestrator(ctx, project(ctx, req), param(req, 'missionId'), req.body))));
  app.post(`${base}/resume`, route(ctx, async (req, res) => res.json(await runOrchestrator(ctx, project(ctx, req), param(req, 'missionId'), req.body))));
  app.post(`${base}/cancel`, route(ctx, (req, res) => res.json(cancelOrchestrator(ctx, project(ctx, req), param(req, 'missionId'), req.body))));
  app.post(`${base}/publish`, route(ctx, async (req, res) => res.json(await publishOrchestration(ctx, project(ctx, req), param(req, 'missionId'), req.body))));
}
