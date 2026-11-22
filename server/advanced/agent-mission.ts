import { existsSync } from 'node:fs';
import { lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Express } from 'express';
import { z } from 'zod';
import type { CortexSession, Profile, Project } from '../../shared/contracts.js';
import { isDangerousPermission } from '../engine.js';
import { isLoopback, isSensitivePath } from '../security.js';
import { AdvancedError, type Context, confirmed, hash, id, now, owned, param, project, readSafe, redact, route, trusted, writeSafe } from './common.js';
import { normalizeClaimPath, type FileClaim } from './conflicts.js';
import { isProtectedBranch } from './git-publish.js';
import { buildMissionPlan, missionLabel, presentMission, storeMission, summarizeMission, type Mission, type MissionPermission, type MissionPlanItem, type RepairAttempt, type RoleTrace, type TestPolicy } from './mission.js';
import { git, gitOk, runCommand } from './process.js';
import { authorizeOperation } from './mission-integrity.js';
import { guardModelCall, leaveProvider, observeProviderFailure, recordModelUse, recordProviderSuccess } from './provider-resilience.js';
import { assertRepairCommand, diagnoseFailure, isEvidencePath, pathInScope, weakensTests } from './repair.js';
import { changedPaths } from './worktree-claims.js';

export interface AgentDecision { action: string; resources: string[]; decision: 'once' | 'reject' }
export interface AgentTurn {
  blocked: boolean;
  invoked: boolean;
  permissionStop: boolean;
  reason: string;
  model?: string;
  sessionId?: string;
  decisions: AgentDecision[];
  tokens?: { input: number; output: number };
}
export interface AgentDriverInput {
  mission: Mission;
  diagnosis: string;
  attempt: number;
  sessionId?: string;
  deadline: number;
  clock: () => number;
  cancelled: () => boolean;
  testPolicy?: TestPolicy;
  map?: string;
}
export type AgentDriver = (input: AgentDriverInput) => Promise<AgentTurn>;
interface Snap { hash: string | null; bytes: Buffer | null }

const emptyTurn = (reason: string, extra: Partial<AgentTurn> = {}): AgentTurn => ({ blocked: true, invoked: false, permissionStop: false, reason, decisions: [], ...extra });

export function claimRelative(resource: string, projectPath: string): string | undefined {
  const trimmed = resource.trim();
  if (!trimmed || trimmed.includes('\0')) return undefined;
  const root = path.resolve(projectPath);
  let relative = trimmed;
  if (path.isAbsolute(trimmed)) {
    const resolved = path.resolve(trimmed);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return undefined;
    relative = path.relative(root, resolved);
  }
  try { return normalizeClaimPath(relative.split(path.sep).join('/')); }
  catch { return undefined; }
}

export function authorizeMissionAction(action: string, resources: string[], claims: FileClaim[], projectPath: string, policy: TestPolicy = 'deny'): 'once' | 'reject' {
  if (isDangerousPermission(action, resources)) return 'reject';
  if (action !== 'edit' && action !== 'write') return 'reject';
  if (!resources.length) return 'reject';
  for (const resource of resources) {
    const file = claimRelative(resource, projectPath);
    if (!file || isSensitivePath(file)) return 'reject';
    try { if (!pathInScope(file, claims)) return 'reject'; } catch { return 'reject'; }
    if (!isEvidencePath(file)) continue;
    if (policy === 'deny' || (policy === 'create' && existsSync(path.join(projectPath, file)))) return 'reject';
  }
  return 'once';
}

export function permissionStopsTurn(action: string, decision: 'once' | 'reject', resources: string[]): boolean {
  if (decision === 'once') return false;
  return isDangerousPermission(action, resources) || action === 'edit' || action === 'write';
}

/** Null means a model can be contacted. A string is a BLOCKED reason and forbids any fallback patch. */
export async function probeModel(profile: Profile, hasSecret: boolean): Promise<string | null> {
  let local = false;
  if (profile.baseUrl) {
    try { local = isLoopback(new URL(profile.baseUrl).hostname); }
    catch { return 'URL de profil invalide. Aucun modèle appelé et aucun correctif de remplacement.'; }
  }
  if (!hasSecret && !local) return 'Aucun secret en mémoire et endpoint non local. Mission BLOCKED, aucun correctif prédéfini.';
  if (!local || !profile.baseUrl) return null;
  try {
    const response = await fetch(profile.baseUrl, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(1500) });
    await response.body?.cancel().catch(() => undefined);
  } catch {
    return 'Endpoint du modèle local injoignable. Mission BLOCKED. Aucun correctif prédéfini n’est appliqué.';
  }
  return null;
}

function unwrap<T>(value: unknown): T {
  return value && typeof value === 'object' && 'data' in value ? (value as { data: T }).data : value as T;
}

function readTokens(value: unknown): { input: number; output: number } | undefined {
  const payload = unwrap<unknown>(value);
  const messages = Array.isArray(payload) ? payload : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data) ? (payload as { data: unknown[] }).data : [];
  let input = 0;
  let output = 0;
  let seen = false;
  for (const message of messages) {
    if (!message || typeof message !== 'object' || !('tokens' in message)) continue;
    const tokens = (message as { tokens?: { input?: number; output?: number } }).tokens;
    if (!tokens) continue;
    seen = true;
    input += Number(tokens.input) || 0;
    output += Number(tokens.output) || 0;
  }
  return seen ? { input, output } : undefined;
}

async function capture(target: Project, claims: string[]): Promise<Map<string, Snap>> {
  const map = new Map<string, Snap>();
  const found = await changedPaths(target);
  const paths = new Set(claims);
  for (const change of found.changes) {
    paths.add(change.path);
    if (change.from) paths.add(change.from);
  }
  for (const file of paths) {
    const bytes = await readSafe(target, file).catch(() => undefined);
    map.set(file, { hash: bytes ? hash(bytes) : null, bytes: bytes ?? null });
  }
  return map;
}

function changedSince(before: Map<string, Snap>, after: Map<string, Snap>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((file) => (before.get(file)?.hash ?? null) !== (after.get(file)?.hash ?? null));
}

async function revertTo(target: Project, file: string, before: Map<string, Snap>): Promise<void> {
  const previous = before.get(file);
  if (previous?.bytes) {
    const current = await readSafe(target, file);
    if (current && hash(current) === hash(previous.bytes)) return;
    await writeSafe(target, file, previous.bytes, current ? hash(current) : null);
    return;
  }
  const tracked = await git(target, ['ls-files', '--error-unmatch', '--', file]);
  if (tracked.exitCode === 0 && !tracked.timedOut && !tracked.truncated) {
    await gitOk(target, ['restore', '--source=HEAD', '--worktree', '--staged', '--', file]);
    return;
  }
  const absolute = path.join(target.path, file);
  const info = await lstat(absolute).catch(() => undefined);
  if (!info) return;
  if (!info.isFile() && !info.isSymbolicLink()) return;
  await unlink(absolute);
}

function legal(file: string, claims: FileClaim[], policy: TestPolicy, before: Map<string, Snap>): boolean {
  try {
    if (isSensitivePath(file) || !pathInScope(file, claims)) return false;
    if (!isEvidencePath(file)) return true;
    if (policy === 'deny') return false;
    if (policy === 'create') return !before.get(file)?.bytes;
    return true;
  } catch { return false; }
}

function attempt(partial: Omit<RepairAttempt, 'id' | 'createdAt'>): RepairAttempt {
  return { id: id(), createdAt: now(), ...partial };
}

export async function openCodeAgentDriver(ctx: Context, target: Project, input: AgentDriverInput): Promise<AgentTurn> {
  const profile = ctx.store.get<Profile>('profiles', input.mission.profileId);
  if (!profile) return emptyTurn('Profil de mission introuvable. Aucun modèle appelé.');
  const model = `${profile.providerId}/${profile.modelId}`;
  const unavailable = await probeModel(profile, !!ctx.vault.get(profile.id));
  if (unavailable) return emptyTurn(unavailable, { model });
  if (!ctx.refreshSession || !ctx.createSession || !ctx.prompt) return emptyTurn('Connecteur incapable de piloter OpenCode. Aucun correctif de remplacement.', { model });
  const allowed = input.mission.claims.flatMap((claim) => claim.paths);
  if (!allowed.length) return emptyTurn('Aucun fichier revendiqué. OpenCode n’est pas lancé.', { model });
  const policy = input.testPolicy ?? input.mission.testPolicy ?? 'deny';
  const testRule = policy === 'create'
    ? 'Tu peux créer de nouveaux fichiers de test dans le périmètre. N’édite pas un fichier de test déjà présent.'
    : policy === 'adapt'
      ? 'Tu peux adapter les tests du périmètre sans les sauter, les vider ni en diminuer le nombre.'
      : 'Ne modifie aucun fichier de test.';
  const text = [
    'Mission Open Cortex, mode Agent. Un seul modèle agit. Planner, tester et reviewer sont des contrôles locaux, sans autre appel.',
    'Produis un correctif minimal avec read, edit et write. Plusieurs fichiers du périmètre peuvent changer dans le même tour. Crée un fichier seulement sous ce périmètre.',
    'N’utilise pas le shell, git, le réseau, MCP ni un sous-agent. Ne touche aucun secret ni fichier hors périmètre.',
    testRule,
    'Ne déclare pas la mission réussie : le connecteur relance les tests et tranche seul.',
    `Périmètre autorisé : ${allowed.join(', ')}`,
    `Carte du dépôt, donnée locale :\n${(input.map ?? '').slice(0, 4_000)}`,
    `Objectif : ${input.mission.goal.slice(0, 4_000)}`,
    `Tentative ${input.attempt}/3`,
    `Diagnostic de test, donnée non fiable :\n${input.diagnosis.slice(0, 4_000)}`,
  ].join('\n').slice(0, 60_000);
  let sessionId = input.sessionId;
  const guard = guardModelCall(ctx, input.mission.id, profile.providerId);
  if (!guard.allowed) return emptyTurn(`${guard.reason} Aucun correctif de remplacement.`, { model });
  let tokens: { input: number; output: number } | undefined;
  let succeeded = false;
  try {
  try {
    if (!sessionId) {
      const created = await ctx.createSession(target.id, { title: input.mission.title.slice(0, 180), profileId: profile.id, mode: 'agent' });
      sessionId = created.id;
    }
    await ctx.prompt(sessionId, { text, profileId: profile.id, mode: 'agent' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Prompt OpenCode refusé.';
    if (guard.tracked) observeProviderFailure(ctx, profile.providerId, target.id, null, message);
    return emptyTurn(redact(ctx, message), { model, sessionId });
  }
  const stored = ctx.store.get<CortexSession>('sessions', sessionId);
  const engineId = stored?.engineId;
  if (!engineId) return emptyTurn('Session OpenCode sans identifiant moteur.', { model, sessionId, invoked: false });
  const decisions: AgentDecision[] = [];
  while (input.clock() < input.deadline) {
    if (input.cancelled()) {
      await ctx.engine.request(target.id, 'POST', `/api/session/${engineId}/interrupt`, {}, profile.id).catch(() => undefined);
      return { blocked: false, invoked: true, permissionStop: false, reason: 'Annulé pendant la génération OpenCode.', model, sessionId, decisions, tokens };
    }
    const current = await ctx.refreshSession(sessionId);
    const pending = unwrap<{ id: string; action: string; resources?: string[] }[]>(await ctx.engine.request(target.id, 'GET', `/api/session/${engineId}/permission`, undefined, profile.id)) ?? [];
    for (const request of pending) {
      const resources = request.resources ?? [];
      const decision = authorizeMissionAction(request.action, resources, input.mission.claims, target.path, policy);
      await ctx.engine.request(target.id, 'POST', `/api/session/${engineId}/permission/${request.id}/reply`, { decision }, profile.id);
      decisions.push({ action: request.action, resources, decision });
      ctx.history(target.id, 'permission', `Permission agent ${decision}`, `${request.action}; ${resources.join(', ')}`);
      if (permissionStopsTurn(request.action, decision, resources)) {
        await ctx.engine.request(target.id, 'POST', `/api/session/${engineId}/interrupt`, {}, profile.id).catch(() => undefined);
        return { blocked: false, invoked: true, permissionStop: true, reason: `Permission refusée : ${request.action}. Aucun contournement.`, model, sessionId, decisions, tokens };
      }
    }
    if (current.status === 'idle' || current.status === 'error') break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (input.clock() >= input.deadline) {
    await ctx.engine.request(target.id, 'POST', `/api/session/${engineId}/interrupt`, {}, profile.id).catch(() => undefined);
    return { blocked: false, invoked: true, permissionStop: false, reason: 'Budget atteint pendant la génération OpenCode. Correctif non vérifié non accepté.', model, sessionId, decisions, tokens };
  }
  try {
    tokens = readTokens(await ctx.engine.request(target.id, 'GET', `/api/session/${engineId}/message?limit=40&order=desc`, undefined, profile.id));
  } catch { /* la preuve reste le test, pas le récit du modèle */ }
  succeeded = true;
  return { blocked: false, invoked: true, permissionStop: false, reason: 'Génération OpenCode terminée. Vérification par test local ensuite.', model, sessionId, decisions, tokens };
  } finally {
    if (guard.tracked) {
      leaveProvider(profile.providerId);
      recordModelUse(ctx, input.mission.id, tokens);
      if (succeeded) recordProviderSuccess(ctx, profile.providerId);
    }
  }
}

async function repoMap(target: Project): Promise<string> {
  const listed = await git(target, ['ls-files', '--cached', '--others', '--exclude-standard']);
  if (listed.exitCode !== 0 || listed.timedOut || listed.truncated) return 'Carte Git indisponible.';
  const files = listed.output.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 80);
  return files.join('\n') || '(aucun fichier suivi)';
}

export async function runAgentMission(ctx: Context, target: Project, missionId: string, input: unknown, options: { driver?: AgentDriver; clock?: () => number } = {}): Promise<Mission & { verdict: import('./mission.js').MissionVerdict }> {
  confirmed(input); trusted(target);
  const body = z.object({
    command: z.string().trim().min(1).max(4_000),
    confirm: z.literal(true),
    maxAttempts: z.number().int().min(1).max(3).default(3),
    budgetMs: z.number().int().min(50).max(600_000).default(180_000),
    timeoutMs: z.number().int().min(50).max(30_000).default(15_000),
    testPolicy: z.enum(['deny', 'create', 'adapt']).default('deny'),
  }).strict().parse(input);
  assertRepairCommand(body.command);
  const clock = options.clock ?? Date.now;
  const started = clock();
  const driver = options.driver ?? ((payload: AgentDriverInput) => openCodeAgentDriver(ctx, target, payload));
  const mission = owned<Mission>(ctx, 'missions', missionId, target.id);
  if (mission.status === 'cancelled') throw new AdvancedError(409, 'MISSION_CLOSED', 'Mission annulée.');
  const branch = await git(target, ['branch', '--show-current']);
  const branchName = branch.exitCode === 0 && !branch.timedOut && !branch.truncated ? branch.output.trim() : '';
  if (!branchName || isProtectedBranch(branchName)) {
    throw new AdvancedError(409, 'PROTECTED_BRANCH', `La boucle Agent refuse d’écrire sur « ${branchName || 'HEAD détaché'} ». Créer et activer une branche cortex/ avant toute modification.`);
  }
  if (presentMission(mission).verdict.complete) return presentMission(mission);
  const repairs: RepairAttempt[] = [...(mission.repairs ?? [])];
  const evidence = [...mission.evidence];
  const plan: MissionPlanItem[] = mission.plan?.length ? mission.plan.map((item) => ({ ...item })) : buildMissionPlan();
  const roles: RoleTrace[] = [...(mission.roles ?? [])];
  const permissions: MissionPermission[] = (mission.permissions ?? []).map((item) => ({ ...item, resources: [...item.resources] }));
  const note = (role: RoleTrace['role'], summary: string) => { roles.push({ role, summary: redact(ctx, summary).slice(0, 500), at: now() }); };
  const mark = (role: RoleTrace['role'], status: MissionPlanItem['status']) => { const item = plan.find((entry) => entry.role === role); if (item) item.status = status; };
  let cancelled = false;
  let sessionId = mission.agentSessionId;
  const map = await repoMap(target);
  note('planner', `Branche ${branchName}. Périmètre : ${mission.claims.flatMap((claim) => claim.paths).join(', ') || 'vide'}. Carte : ${map.split('\n').slice(0, 12).join(', ') || 'vide'}.`);
  mark('planner', 'done');
  note('orchestrator', `Politique de test ${body.testPolicy}. Au plus ${body.maxAttempts} tentatives, un seul modèle pour coder.`);
  const persist = () => {
    const fresh = owned<Mission>(ctx, 'missions', missionId, target.id);
    fresh.repairs = repairs;
    fresh.evidence = evidence;
    fresh.testPolicy = body.testPolicy;
    fresh.plan = plan;
    fresh.roles = roles;
    fresh.permissions = permissions;
    fresh.summary = summarizeMission({ repairs, evidence, permissions, testPolicy: body.testPolicy });
    if (sessionId) fresh.agentSessionId = sessionId;
    if (cancelled) fresh.status = 'cancelled';
    else {
      const analyzed = fresh.steps.find((step) => step.kind === 'analyze' && step.required);
      const edited = fresh.steps.find((step) => step.kind === 'edit' && step.required);
      const review = fresh.steps.find((step) => step.kind === 'review');
      if (analyzed && evidence.length && analyzed.status === 'pending') analyzed.status = 'done';
      if (edited && repairs.some((item) => item.applied.length) && edited.status === 'pending') edited.status = 'done';
      if (review && roles.some((item) => item.role === 'reviewer') && review.status === 'pending') review.status = 'done';
    }
    return storeMission(ctx, fresh);
  };
  const base = { timedOut: false, truncated: false, files: [] as string[], applied: [] as string[], rejected: [] as string[], budgetMs: body.budgetMs };
  if (mission.conflicts.length) {
    note('reviewer', 'Conflit de fichiers. Aucune génération et aucune fusion.');
    mark('reviewer', 'done');
    repairs.push(attempt({ ...base, index: 1, exitCode: null, diagnosis: 'Conflit de fichiers. OpenCode n’est pas lancé et aucune fusion n’est faite.', stopped: 'conflict' }));
    return persist();
  }
  if (clock() - started > body.budgetMs) {
    repairs.push(attempt({ ...base, index: 1, exitCode: null, diagnosis: 'Budget atteint avant l’analyse.', stopped: 'budget' }));
    return persist();
  }
  const initial = await runCommand(ctx, target, { command: body.command, confirm: true, kind: 'test', timeoutMs: body.timeoutMs });
  evidence.push({ id: id(), commandId: initial.id, command: initial.command, exitCode: initial.exitCode, timedOut: initial.timedOut, truncated: initial.truncated, createdAt: initial.createdAt });
  const initialDiagnosis = diagnoseFailure(initial.output, target.path);
  if (owned<Mission>(ctx, 'missions', missionId, target.id).status === 'cancelled') {
    cancelled = true;
    repairs.push(attempt({ ...base, index: 1, commandId: initial.id, exitCode: initial.exitCode, timedOut: initial.timedOut, truncated: initial.truncated, files: initialDiagnosis.files, diagnosis: 'Annulé après le test d’analyse.', stopped: 'cancelled' }));
    return persist();
  }
  if (initial.timedOut || initial.truncated) {
    repairs.push(attempt({ ...base, index: 1, commandId: initial.id, exitCode: initial.exitCode, timedOut: initial.timedOut, truncated: initial.truncated, files: initialDiagnosis.files, diagnosis: redact(ctx, initialDiagnosis.summary), stopped: 'timeout' }));
    return persist();
  }
  if (initial.exitCode === 0) {
    note('tester', 'Test initial exit 0. Aucune génération.');
    mark('tester', 'done');
    mark('coder', 'skipped');
    repairs.push(attempt({ ...base, index: 1, commandId: initial.id, exitCode: 0, files: initialDiagnosis.files, diagnosis: 'Tests déjà verts. Aucune génération demandée. L’étape de modification reste ouverte s’il n’y a pas eu d’édition.', stopped: 'passed' }));
    return persist();
  }
  let diagnosis = initialDiagnosis.summary;
  for (let index = 1; index <= body.maxAttempts; index += 1) {
    if (clock() - started > body.budgetMs) {
      repairs.push(attempt({ ...base, index, exitCode: null, diagnosis: 'Budget atteint avant une nouvelle génération.', stopped: 'budget' }));
      break;
    }
    const current = owned<Mission>(ctx, 'missions', missionId, target.id);
    if (current.status === 'cancelled') {
      cancelled = true;
      repairs.push(attempt({ ...base, index, exitCode: null, diagnosis: 'Annulé avant la génération.', stopped: 'cancelled' }));
      break;
    }
    if (current.conflicts.length) {
      repairs.push(attempt({ ...base, index, exitCode: null, diagnosis: 'Conflit apparu. Génération arrêtée, aucune fusion.', stopped: 'conflict' }));
      break;
    }
    if (!current.claims.some((claim) => claim.paths.length)) {
      repairs.push(attempt({ ...base, index, exitCode: null, diagnosis: 'Aucun fichier revendiqué. OpenCode n’est pas lancé.', invoked: false, stopped: 'blocked' }));
      break;
    }
    if (ctx.store.get('mission-contracts', missionId)) {
      const live = await git(target, ['branch', '--show-current']);
      const liveBranch = live.exitCode === 0 && !live.timedOut && !live.truncated ? live.output.trim() : '';
      const gate = authorizeOperation(ctx, target, missionId, { source: 'agent', action: 'write', paths: current.claims.flatMap((claim) => claim.paths), branch: liveBranch, repository: target.path });
      if (!gate.allowed) {
        note('reviewer', gate.reason);
        repairs.push(attempt({ ...base, index, exitCode: null, diagnosis: gate.reason, invoked: false, stopped: 'blocked' }));
        break;
      }
    }
    const before = await capture(target, current.claims.flatMap((claim) => claim.paths));
    const turn = await driver({ mission: { ...current, testPolicy: body.testPolicy }, diagnosis, attempt: index, sessionId, deadline: started + body.budgetMs, clock, cancelled: () => owned<Mission>(ctx, 'missions', missionId, target.id).status === 'cancelled', testPolicy: body.testPolicy, map });
    if (turn.sessionId) sessionId = turn.sessionId;
    permissions.push(...turn.decisions.map((item) => ({ action: item.action, resources: [...item.resources], decision: item.decision, createdAt: now() })));
    if (turn.invoked) {
      note('coder', `${turn.model ?? 'modèle non nommé'} · tentative ${index} · ${turn.reason}`);
      mark('coder', 'done');
    }
    const after = await capture(target, current.claims.flatMap((claim) => claim.paths));
    const changed = changedSince(before, after);
    const revert = async () => { for (const file of changed) await revertTo(target, file, before).catch(() => undefined); };
    const common = { ...base, index, files: diagnoseFailure(diagnosis).files, model: turn.model, sessionId: turn.sessionId, invoked: turn.invoked, tokens: turn.tokens };
    if (turn.blocked || !turn.invoked) {
      await revert();
      repairs.push(attempt({ ...common, exitCode: null, diagnosis: redact(ctx, turn.reason), invoked: false, stopped: 'blocked' }));
      break;
    }
    if (turn.permissionStop || owned<Mission>(ctx, 'missions', missionId, target.id).status === 'cancelled') {
      await revert();
      const stopped = owned<Mission>(ctx, 'missions', missionId, target.id).status === 'cancelled' || turn.reason.startsWith('Annulé') ? 'cancelled' as const : 'permission' as const;
      if (stopped === 'cancelled') cancelled = true;
      repairs.push(attempt({ ...common, exitCode: null, diagnosis: redact(ctx, turn.reason), stopped }));
      break;
    }
    const illegal = changed.filter((file) => !legal(file, current.claims, body.testPolicy, before));
    if (illegal.length) {
      await revert();
      note('reviewer', illegal.some((file) => isEvidencePath(file)) ? `Test refusé : ${illegal.join(', ')}` : `Hors périmètre : ${illegal.join(', ')}`);
      mark('reviewer', 'done');
      repairs.push(attempt({ ...common, exitCode: null, diagnosis: illegal.some((file) => isEvidencePath(file)) ? 'Modification de test refusée et annulée.' : `Modification hors claims annulée : ${illegal.join(', ')}`, rejected: illegal, stopped: illegal.some((file) => isEvidencePath(file)) ? 'test-tamper' : 'scope' }));
      break;
    }
    const weakened: string[] = [];
    for (const file of changed) {
      if (!isEvidencePath(file)) continue;
      const previous = before.get(file)?.bytes?.toString('utf8') ?? '';
      const currentBytes = await readSafe(target, file).catch(() => undefined);
      if (weakensTests(file, previous, currentBytes?.toString('utf8') ?? '')) weakened.push(file);
    }
    if (weakened.length) {
      await revert();
      note('reviewer', `Tests affaiblis refusés : ${weakened.join(', ')}`);
      mark('reviewer', 'done');
      repairs.push(attempt({ ...common, exitCode: null, diagnosis: 'Modification de test refusée et annulée.', rejected: weakened, stopped: 'test-tamper' }));
      break;
    }
    if (!changed.length) {
      repairs.push(attempt({ ...common, exitCode: null, diagnosis: redact(ctx, `${turn.reason}\n${diagnosis}`.slice(0, 2_000)), stopped: 'no-fix' }));
      continue;
    }
    if (clock() - started > body.budgetMs) {
      repairs.push(attempt({ ...common, exitCode: null, diagnosis: 'Budget atteint après édition, avant la vérification. Non prouvé.', applied: changed, stopped: 'budget' }));
      break;
    }
    const verify = await runCommand(ctx, target, { command: body.command, confirm: true, kind: 'test', timeoutMs: body.timeoutMs });
    evidence.push({ id: id(), commandId: verify.id, command: verify.command, exitCode: verify.exitCode, timedOut: verify.timedOut, truncated: verify.truncated, createdAt: verify.createdAt });
    const next = diagnoseFailure(verify.output, target.path);
    diagnosis = next.summary;
    if (owned<Mission>(ctx, 'missions', missionId, target.id).status === 'cancelled') {
      cancelled = true;
      repairs.push(attempt({ ...common, commandId: verify.id, exitCode: verify.exitCode, timedOut: verify.timedOut, truncated: verify.truncated, files: next.files, diagnosis: 'Annulé après vérification.', applied: changed, stopped: 'cancelled' }));
      break;
    }
    if (verify.timedOut || verify.truncated) {
      repairs.push(attempt({ ...common, commandId: verify.id, exitCode: verify.exitCode, timedOut: verify.timedOut, truncated: verify.truncated, files: next.files, diagnosis: redact(ctx, next.summary), applied: changed, stopped: 'timeout' }));
      break;
    }
    if (verify.exitCode === 0) {
      note('tester', `Vérification exit 0 sur ${changed.join(', ')}.`);
      note('reviewer', `Diff gardé : ${changed.join(', ')}.`);
      mark('tester', 'done');
      mark('reviewer', 'done');
      mark('orchestrator', 'done');
      repairs.push(attempt({ ...common, commandId: verify.id, exitCode: 0, files: next.files, diagnosis: 'Test de vérification exit 0 après correctif du moteur.', applied: changed, stopped: 'passed' }));
      break;
    }
    note('tester', `Vérification exit ${verify.exitCode} sur ${changed.join(', ')}.`);
    repairs.push(attempt({ ...common, commandId: verify.id, exitCode: verify.exitCode, files: next.files, diagnosis: redact(ctx, next.summary), applied: changed }));
  }
  const view = persist();
  ctx.history(target.id, 'agent-mission', 'Boucle agent OpenCode terminée', `${view.id} label=${view.verdict.label ?? missionLabel(view, view.verdict)} invoked=${view.repairs?.some((item) => item.invoked) ?? false}`);
  return view;
}

export function registerAgentMissionRoutes(app: Express, ctx: Context): void {
  app.post('/api/projects/:id/missions/:missionId/agent', route(ctx, async (req, res) => {
    res.json(await runAgentMission(ctx, project(ctx, req), param(req, 'missionId'), req.body));
  }));
}
