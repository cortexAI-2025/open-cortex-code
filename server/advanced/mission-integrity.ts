import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { Express } from 'express';
import { z } from 'zod';
import type { Project } from '../../shared/contracts.js';
import { AdvancedError, type Context, all, confirmed, now, param, project, redact, route, trusted } from './common.js';
import { normalizeClaimPath } from './conflicts.js';
import type { Mission } from './mission.js';
import { acquireLease, beginExternal, detectAbandoned, finishLease, type LeaseRecord } from './resilience.js';

export type IntegritySource = 'user' | 'summary' | 'memory' | 'tool' | 'agent';
export type IntegrityAction = 'write' | 'execute' | 'publish' | 'retarget' | 'mutate-contract';
export interface ContractPermissions { allowCommit: boolean; allowPush: boolean; allowPullRequest: boolean }
export interface IntegrityDecision { allowed: boolean; code: string; reason: string; at: string }
export interface MissionContract {
  id: string;
  projectId: string;
  originalInstruction: string;
  objective: string;
  repository: string;
  branch: string;
  scope: string[];
  permissions: ContractPermissions;
  acceptance: string[];
  createdAt: string;
  version: number;
  fingerprint: string;
  decisions: IntegrityDecision[];
}
export interface MissionProgress {
  id: string;
  projectId: string;
  steps: Record<string, 'pending' | 'done' | 'running'>;
  runs: Record<string, number>;
  updatedAt: string;
}

const sources = ['user', 'summary', 'memory', 'tool', 'agent'] as const;
const permissionsOf = (input?: Partial<ContractPermissions>): ContractPermissions => ({
  allowCommit: input?.allowCommit === true,
  allowPush: input?.allowPush === true,
  allowPullRequest: input?.allowPullRequest === true,
});

/** Forme canonique déterministe. L’égalité est exacte : ce n’est pas une similarité. */
export function canonicalObjective(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function authority(contract: Pick<MissionContract, 'id' | 'projectId' | 'originalInstruction' | 'objective' | 'repository' | 'branch' | 'scope' | 'permissions' | 'acceptance' | 'createdAt' | 'version'>): string {
  const body = {
    acceptance: [...contract.acceptance].sort(),
    branch: contract.branch,
    createdAt: contract.createdAt,
    id: contract.id,
    objective: contract.objective,
    originalInstruction: contract.originalInstruction,
    permissions: contract.permissions,
    projectId: contract.projectId,
    repository: contract.repository,
    scope: [...contract.scope].sort(),
    version: contract.version,
  };
  return JSON.stringify(body);
}

export function fingerprintContract(contract: Pick<MissionContract, 'id' | 'projectId' | 'originalInstruction' | 'objective' | 'repository' | 'branch' | 'scope' | 'permissions' | 'acceptance' | 'createdAt' | 'version'>): string {
  return createHash('sha256').update(authority(contract)).digest('hex');
}

function repositoryOf(target: Project): string {
  return realpathSync(target.path);
}

function remember(ctx: Context, contract: MissionContract, decision: IntegrityDecision): IntegrityDecision {
  contract.decisions = [...contract.decisions, decision].slice(-30);
  ctx.store.put('mission-contracts', contract, contract.projectId);
  return decision;
}

function decision(allowed: boolean, code: string, reason: string): IntegrityDecision {
  return { allowed, code, reason, at: now() };
}

export function readContract(ctx: Context, missionId: string): { contract: MissionContract; intact: boolean } | undefined {
  const contract = ctx.store.get<MissionContract>('mission-contracts', missionId);
  if (!contract) return undefined;
  const intact = fingerprintContract(contract) === contract.fingerprint;
  return { contract, intact };
}

function inScope(file: string, scope: string[]): boolean {
  let normalized: string;
  try { normalized = normalizeClaimPath(file); } catch { return false; }
  return scope.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

export function sealContract(ctx: Context, target: Project, missionId: string, input: unknown): MissionContract {
  confirmed(input); trusted(target);
  const parsed = z.object({
    confirm: z.literal(true),
    branch: z.string().trim().min(1).max(200),
    scope: z.array(z.string().trim().min(1).max(500)).min(1).max(80),
    acceptance: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    permissions: z.object({ allowCommit: z.boolean().optional(), allowPush: z.boolean().optional(), allowPullRequest: z.boolean().optional() }).strict().optional(),
    objective: z.string().trim().min(1).max(4_000).optional(),
  }).strict().parse(input);
  if (ctx.store.get('mission-contracts', missionId)) throw new AdvancedError(409, 'CONTRACT_EXISTS', 'Le contrat original existe déjà. Une modification exige une autorisation explicite.');
  const mission = ctx.store.get<Mission>('missions', missionId);
  if (!mission || mission.projectId !== target.id) throw new AdvancedError(404, 'NOT_FOUND', 'Mission introuvable pour ce contrat.');
  const objective = canonicalObjective(parsed.objective ?? mission.goal);
  const scope = parsed.scope.map((item) => normalizeClaimPath(item));
  const contract: MissionContract = {
    id: missionId, projectId: target.id, originalInstruction: canonicalObjective(mission.goal), objective,
    repository: repositoryOf(target), branch: parsed.branch, scope, permissions: permissionsOf(parsed.permissions),
    acceptance: parsed.acceptance.map((item) => item.trim()), createdAt: now(), version: 1, fingerprint: '', decisions: [],
  };
  contract.fingerprint = fingerprintContract(contract);
  contract.decisions.push(decision(true, 'SEALED', 'Contrat scellé depuis l’instruction originale. Un résumé ne peut pas le remplacer.'));
  return ctx.store.put('mission-contracts', contract, target.id);
}

export function amendContract(ctx: Context, target: Project, missionId: string, input: unknown): MissionContract | IntegrityDecision {
  confirmed(input); trusted(target);
  const parsed = z.object({
    confirm: z.literal(true),
    source: z.enum(sources).optional(),
    objective: z.string().trim().min(1).max(4_000).optional(),
    branch: z.string().trim().min(1).max(200).optional(),
    scope: z.array(z.string().trim().min(1).max(500)).min(1).max(80).optional(),
    permissions: z.object({ allowCommit: z.boolean().optional(), allowPush: z.boolean().optional(), allowPullRequest: z.boolean().optional() }).strict().optional(),
  }).strict().parse(input);
  const source = parsed.source ?? 'user';
  const loaded = readContract(ctx, missionId);
  if (!loaded || loaded.contract.projectId !== target.id) throw new AdvancedError(404, 'CONTRACT_ABSENT', 'Aucun contrat actif.');
  if (!loaded.intact) return remember(ctx, loaded.contract, decision(false, 'CONTRACT_TAMPER', 'Empreinte invalide. Le contrat altéré n’autorise aucune écriture.'));
  if (source !== 'user') {
    return remember(ctx, loaded.contract, decision(false, 'CONTRACT_MUTATION_DENIED', 'Un agent, un outil, une mémoire ou un résumé ne peut pas modifier le contrat.'));
  }
  const next: MissionContract = {
    ...loaded.contract,
    objective: parsed.objective ? canonicalObjective(parsed.objective) : loaded.contract.objective,
    branch: parsed.branch ?? loaded.contract.branch,
    scope: parsed.scope ? parsed.scope.map((item) => normalizeClaimPath(item)) : loaded.contract.scope,
    permissions: parsed.permissions ? permissionsOf({ ...loaded.contract.permissions, ...parsed.permissions }) : loaded.contract.permissions,
    version: loaded.contract.version + 1,
    decisions: loaded.contract.decisions,
  };
  if (next.objective === loaded.contract.objective && next.branch === loaded.contract.branch && next.scope.join('\0') === loaded.contract.scope.join('\0') && JSON.stringify(next.permissions) === JSON.stringify(loaded.contract.permissions)) {
    return remember(ctx, loaded.contract, decision(false, 'CONTRACT_UNCHANGED', 'Aucun changement explicite.'));
  }
  next.fingerprint = fingerprintContract(next);
  next.decisions = [...loaded.contract.decisions, decision(true, 'AMENDED', `Contrat version ${next.version} approuvé par l’utilisateur. L’instruction originale est conservée.`)].slice(-30);
  const mission = ctx.store.get<Mission>('missions', missionId);
  if (mission && mission.projectId === target.id && parsed.objective) {
    mission.goal = next.objective;
    mission.updatedAt = now();
    ctx.store.put('missions', mission, target.id);
  }
  return ctx.store.put('mission-contracts', next, target.id);
}

export interface OperationRequest {
  source: IntegritySource;
  action: IntegrityAction;
  paths?: string[];
  repository?: string;
  branch?: string;
  permissions?: Partial<ContractPermissions>;
  proposedObjective?: string;
  approved?: boolean;
}

export function authorizeOperation(ctx: Context, target: Project, missionId: string, request: OperationRequest): IntegrityDecision {
  const loaded = readContract(ctx, missionId);
  if (!loaded) return decision(true, 'NO_CONTRACT', 'Aucun contrat scellé. Le comportement antérieur est conservé.');
  if (loaded.contract.projectId !== target.id) return decision(false, 'REPOSITORY_DENIED', 'Le contrat appartient à un autre projet.');
  if (!loaded.intact) return remember(ctx, loaded.contract, decision(false, 'CONTRACT_TAMPER', 'Empreinte invalide. Opération refusée avant toute écriture.'));
  const contract = loaded.contract;
  if (request.action === 'mutate-contract' || (request.source !== 'user' && request.action === 'retarget')) {
    return remember(ctx, contract, decision(false, 'CONTRACT_MUTATION_DENIED', 'Modification du contrat refusée pour cette source.'));
  }
  let repository = '';
  let requested = request.repository ?? '';
  try { repository = repositoryOf(target); } catch { repository = ''; }
  if (request.repository) {
    try { requested = realpathSync(request.repository); } catch { requested = request.repository; }
  }
  if (!repository || repository !== contract.repository || (request.repository && requested !== contract.repository)) {
    return remember(ctx, contract, decision(false, 'REPOSITORY_DENIED', 'Dépôt différent du contrat. Aucune bascule.'));
  }
  const mission = ctx.store.get<Mission>('missions', missionId);
  const goalDrift = mission ? canonicalObjective(mission.goal) !== canonicalObjective(contract.objective) : false;
  const proposed = request.proposedObjective ? canonicalObjective(request.proposedObjective) : '';
  const proposalDrift = proposed !== '' && proposed !== canonicalObjective(contract.objective);
  if (goalDrift || proposalDrift) {
    const userApproved = request.source === 'user' && request.approved === true && request.action === 'retarget';
    if (!userApproved) {
      return remember(ctx, contract, decision(false, 'OBJECTIVE_DRIFT', 'L’objectif proposé ou enregistré n’est pas celui du contrat. Un résumé, une mémoire ou un outil ne peut pas changer la mission.'));
    }
  }
  if (request.action === 'publish' || request.branch !== undefined) {
    if (!request.branch || request.branch !== contract.branch) {
      return remember(ctx, contract, decision(false, 'BRANCH_DENIED', `Branche « ${request.branch || 'absente'} » refusée. Branche autorisée : ${contract.branch}.`));
    }
  }
  if (request.permissions) {
    const asked = permissionsOf(request.permissions);
    if ((asked.allowCommit && !contract.permissions.allowCommit) || (asked.allowPush && !contract.permissions.allowPush) || (asked.allowPullRequest && !contract.permissions.allowPullRequest)) {
      return remember(ctx, contract, decision(false, 'PERMISSION_DENIED', 'Permission absente du contrat. allowCommit, allowPush et allowPullRequest restent indépendantes.'));
    }
  }
  if (request.action === 'write' || request.action === 'publish') {
    for (const file of request.paths ?? []) {
      if (!inScope(file, contract.scope)) {
        return remember(ctx, contract, decision(false, 'SCOPE_DENIED', `Chemin hors périmètre : ${redact(ctx, file).slice(0, 180)}.`));
      }
    }
  }
  return remember(ctx, contract, decision(true, 'ALLOW', 'Opération conforme au contrat actif.'));
}

export function resumeInterrupted(ctx: Context, projectId: string, missionId: string): { abandoned: string[]; resumed: string[]; skipped: string[]; exactlyOnce: false } {
  const abandoned = detectAbandoned(ctx, projectId).filter((lease) => lease.missionId === missionId);
  const progress = ctx.store.get<MissionProgress>('mission-progress', missionId) ?? { id: missionId, projectId, steps: {}, runs: {}, updatedAt: now() };
  const skipped: string[] = [];
  const resumed: string[] = [];
  for (const [step, state] of Object.entries(progress.steps)) {
    if (state === 'done') skipped.push(step);
  }
  for (const lease of abandoned) {
    if (lease.externalState === 'acked' || lease.externalState === 'unknown') {
      const again = beginExternal(ctx, projectId, lease.idempotencyKey, () => undefined);
      if (again.duplicate) skipped.push(`external:${lease.idempotencyKey}`);
      continue;
    }
    if (lease.checkpoint === 'passed' || progress.steps[lease.taskKey] === 'done') {
      skipped.push(lease.taskKey);
      continue;
    }
    progress.runs[lease.taskKey] = (progress.runs[lease.taskKey] ?? 0) + 1;
    progress.steps[lease.taskKey] = 'done';
    resumed.push(lease.taskKey);
    try { finishLease(ctx, projectId, lease.id, 'passed'); } catch { /* bail déjà clos */ }
  }
  progress.updatedAt = now();
  ctx.store.put('mission-progress', progress, projectId);
  return { abandoned: abandoned.map((lease) => lease.id), resumed, skipped, exactlyOnce: false };
}

export function holdStep(ctx: Context, projectId: string, missionId: string, taskKey: string, ttlMs = 60_000): LeaseRecord {
  const progress = ctx.store.get<MissionProgress>('mission-progress', missionId) ?? { id: missionId, projectId, steps: {}, runs: {}, updatedAt: now() };
  progress.steps[taskKey] = 'running';
  progress.runs[taskKey] = progress.runs[taskKey] ?? 0;
  progress.updatedAt = now();
  ctx.store.put('mission-progress', progress, projectId);
  const lease = acquireLease(ctx, { projectId, missionId, taskKey, ttlMs });
  if (!lease.ok) throw new AdvancedError(409, lease.code, 'Bail non acquis.');
  return lease.lease;
}

export function completeStep(ctx: Context, projectId: string, missionId: string, taskKey: string): void {
  const progress = ctx.store.get<MissionProgress>('mission-progress', missionId) ?? { id: missionId, projectId, steps: {}, runs: {}, updatedAt: now() };
  progress.steps[taskKey] = 'done';
  progress.runs[taskKey] = (progress.runs[taskKey] ?? 0) + 1;
  progress.updatedAt = now();
  ctx.store.put('mission-progress', progress, projectId);
}

const checkSchema = z.object({
  confirm: z.literal(true),
  source: z.enum(sources),
  action: z.enum(['write', 'execute', 'publish', 'retarget', 'mutate-contract']),
  paths: z.array(z.string().max(500)).max(40).optional(),
  repository: z.string().max(4_096).optional(),
  branch: z.string().max(200).optional(),
  proposedObjective: z.string().max(4_000).optional(),
  permissions: z.object({ allowCommit: z.boolean().optional(), allowPush: z.boolean().optional(), allowPullRequest: z.boolean().optional() }).strict().optional(),
  approved: z.boolean().optional(),
}).strict();

export function registerIntegrityRoutes(app: Express, ctx: Context): void {
  app.get('/api/projects/:id/contracts', route(ctx, (req, res) => {
    const target = project(ctx, req);
    res.json(all<MissionContract>(ctx, 'mission-contracts', target.id).map((contract) => ({ ...contract, intact: fingerprintContract(contract) === contract.fingerprint })));
  }));
  app.post('/api/projects/:id/missions/:missionId/contract', route(ctx, (req, res) => {
    res.status(201).json(sealContract(ctx, project(ctx, req), param(req, 'missionId'), req.body));
  }));
  app.post('/api/projects/:id/missions/:missionId/contract/amend', route(ctx, (req, res) => {
    const result = amendContract(ctx, project(ctx, req), param(req, 'missionId'), req.body);
    if ('fingerprint' in result) res.json(result);
    else res.status(409).json(result);
  }));
  app.post('/api/projects/:id/missions/:missionId/contract/check', route(ctx, (req, res) => {
    const target = project(ctx, req);
    trusted(target);
    const body = checkSchema.parse(req.body);
    res.json(authorizeOperation(ctx, target, param(req, 'missionId'), body));
  }));
}
