import type { Express } from 'express';
import { z } from 'zod';
import type { Profile, Project } from '../../shared/contracts.js';
import { AdvancedError, type Context, aiText, all, confirmed, id, label, now, owned, param, project, redact, requireProfile, route, trusted } from './common.js';
import { packContext, modelHandoff, type ContextItem } from './context-budget.js';
import { detectClaimConflicts, type FileClaim, type PathConflict } from './conflicts.js';
import { authorizeOperation } from './mission-integrity.js';
import type { StoredCommand } from './process.js';

export type MissionStatus = 'active' | 'blocked' | 'needs-evidence' | 'proven' | 'failed' | 'cancelled';
export type StepKind = 'analyze' | 'edit' | 'test' | 'review' | 'publish';
export interface MissionStep { id: string; title: string; kind: StepKind; status: 'pending' | 'done' | 'skipped' | 'failed'; required: boolean }
export interface TestEvidence { id: string; commandId: string; command: string; exitCode: number | null; timedOut: boolean; truncated: boolean; createdAt: string }
export interface RepairAttempt {
  id: string;
  index: number;
  commandId?: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  files: string[];
  diagnosis: string;
  applied: string[];
  rejected: string[];
  stopped?: 'passed' | 'budget' | 'timeout' | 'cancelled' | 'no-fix' | 'scope' | 'test-tamper' | 'permission' | 'blocked' | 'conflict';
  model?: string;
  sessionId?: string;
  invoked?: boolean;
  budgetMs?: number;
  tokens?: { input: number; output: number };
  createdAt: string;
}
export interface Mission {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  profileId: string;
  status: MissionStatus;
  steps: MissionStep[];
  claims: FileClaim[];
  conflicts: PathConflict[];
  evidence: TestEvidence[];
  repairs?: RepairAttempt[];
  branch?: string;
  createdAt: string;
  updatedAt: string;
  resumeCount: number;
  agentSessionId?: string;
  testPolicy?: TestPolicy;
  plan?: MissionPlanItem[];
  roles?: RoleTrace[];
  permissions?: MissionPermission[];
  summary?: string;
}
export interface MissionVerdict { complete: boolean; status: MissionStatus; reasons: string[]; label?: MissionLabel }
export type MissionLabel = 'PROVEN' | 'FAILED' | 'BLOCKED' | 'CANCELLED' | 'IN_PROGRESS';
export type TestPolicy = 'deny' | 'create' | 'adapt';
export type MissionRole = 'orchestrator' | 'planner' | 'coder' | 'tester' | 'reviewer';
export interface MissionPlanItem { id: string; role: MissionRole; title: string; status: 'pending' | 'done' | 'skipped' }
export interface RoleTrace { role: MissionRole; summary: string; at: string }
export interface MissionPermission { action: string; resources: string[]; decision: 'once' | 'reject'; createdAt: string }

export function missionLabel(mission: Pick<Mission, 'repairs'>, verdict: MissionVerdict): MissionLabel {
  if (verdict.status === 'cancelled') return 'CANCELLED';
  if (verdict.complete) return 'PROVEN';
  if (verdict.status === 'blocked') return 'BLOCKED';
  if (verdict.status === 'failed') return 'FAILED';
  const last = mission.repairs?.at(-1);
  if (last?.stopped === 'blocked' || last?.stopped === 'permission' || last?.stopped === 'conflict' || last?.stopped === 'scope' || last?.stopped === 'test-tamper') return 'BLOCKED';
  if (last && last.index >= 3 && last.stopped && last.stopped !== 'passed') return 'FAILED';
  return 'IN_PROGRESS';
}

const PROOF_RULE = 'Ne pas déclarer la mission terminée sans un test local exit 0, non tronqué et sans timeout, et sans conflit de fichiers.';

export function completionVerdict(mission: Pick<Mission, 'status' | 'steps' | 'conflicts' | 'evidence'>): MissionVerdict {
  if (mission.status === 'cancelled') return { complete: false, status: 'cancelled', reasons: ['Mission annulée. Aucune réussite n’est déduite.'] };
  if (mission.conflicts.length) {
    return { complete: false, status: 'blocked', reasons: mission.conflicts.map((conflict) => `Conflit ${conflict.path} : ${conflict.agents.join(', ')}`) };
  }
  const failed = mission.steps.filter((step) => step.status === 'failed');
  if (failed.length) return { complete: false, status: 'failed', reasons: failed.map((step) => `Étape en échec : ${step.title}`) };
  const reasons: string[] = [];
  const pending = mission.steps.filter((step) => step.required && step.status !== 'done');
  if (pending.length) reasons.push(`Étapes obligatoires inachevées : ${pending.map((step) => step.title).join(', ')}.`);
  const latest = mission.evidence.at(-1);
  if (!latest) reasons.push('Aucun test enregistré comme preuve.');
  else if (latest.exitCode !== 0 || latest.timedOut || latest.truncated || latest.exitCode === null) {
    reasons.push(`Dernière preuve insuffisante (exit=${latest.exitCode}, timeout=${latest.timedOut}, tronqué=${latest.truncated}).`);
  }
  if (reasons.length) return { complete: false, status: latest && !pending.length ? 'needs-evidence' : pending.length && !latest ? 'active' : 'needs-evidence', reasons };
  return { complete: true, status: 'proven', reasons: ['Preuve acceptée : dernier test exit 0, complet, sans timeout, étapes obligatoires closes, aucun conflit.'] };
}

function syncTestStep(mission: Mission): void {
  const step = mission.steps.find((item) => item.kind === 'test' && item.required);
  if (!step || step.status === 'skipped' || step.status === 'failed') return;
  const latest = mission.evidence.at(-1);
  if (!latest) { step.status = 'pending'; return; }
  step.status = latest.exitCode === 0 && !latest.timedOut && !latest.truncated ? 'done' : 'pending';
}

export function presentMission(mission: Mission): Mission & { verdict: MissionVerdict } {
  const copy: Mission = {
    ...mission,
    steps: mission.steps.map((step) => ({ ...step })),
    claims: mission.claims.map((claim) => ({ agentId: claim.agentId, paths: [...claim.paths] })),
    conflicts: mission.conflicts.map((conflict) => ({ path: conflict.path, agents: [...conflict.agents] })),
    evidence: mission.evidence.map((item) => ({ ...item })),
    repairs: (mission.repairs ?? []).map((item) => ({ ...item, files: [...item.files], applied: [...item.applied], rejected: [...item.rejected], tokens: item.tokens ? { ...item.tokens } : undefined })),
    plan: mission.plan?.map((item) => ({ ...item })),
    roles: mission.roles?.map((item) => ({ ...item })),
    permissions: mission.permissions?.map((item) => ({ ...item, resources: [...item.resources] })),
  };
  if (copy.status !== 'cancelled') syncTestStep(copy);
  const verdict = { ...completionVerdict(copy), label: undefined as MissionLabel | undefined };
  verdict.label = missionLabel(copy, verdict);
  if (copy.status !== 'cancelled') copy.status = verdict.status;
  return { ...copy, verdict };
}

function save(ctx: Context, mission: Mission): Mission & { verdict: MissionVerdict } {
  mission.updatedAt = now();
  const view = presentMission(mission);
  const { verdict: _verdict, ...stored } = view;
  ctx.store.put('missions', stored, mission.projectId);
  return view;
}

export function storeMission(ctx: Context, mission: Mission): Mission & { verdict: MissionVerdict } {
  return save(ctx, mission);
}

export function buildMissionPlan(): MissionPlanItem[] {
  return [
    { id: id(), role: 'planner', title: 'Carte du dépôt et périmètre autorisé', status: 'pending' },
    { id: id(), role: 'coder', title: 'Modifier les fichiers du périmètre via OpenCode', status: 'pending' },
    { id: id(), role: 'tester', title: 'Exécuter le test réel du connecteur', status: 'pending' },
    { id: id(), role: 'reviewer', title: 'Contrôler le diff sans se fier au récit du modèle', status: 'pending' },
    { id: id(), role: 'orchestrator', title: 'Trancher uniquement d’après le dernier test', status: 'pending' },
  ];
}

export function summarizeMission(mission: Pick<Mission, 'repairs' | 'evidence' | 'permissions' | 'testPolicy'>): string {
  const files = [...new Set((mission.repairs ?? []).flatMap((item) => item.applied))];
  const tokens = (mission.repairs ?? []).reduce((sum, item) => ({ input: sum.input + (item.tokens?.input ?? 0), output: sum.output + (item.tokens?.output ?? 0) }), { input: 0, output: 0 });
  const latest = mission.evidence.at(-1);
  const permissions = (mission.permissions ?? []).map((item) => `${item.decision} ${item.action} ${item.resources.join(', ')}`).join(' ; ');
  return [
    `Fichiers gardés : ${files.join(', ') || 'aucun'}.`,
    `Dernier test : exit ${latest ? latest.exitCode : 'absent'}, timeout=${latest?.timedOut ?? false}, tronqué=${latest?.truncated ?? false}.`,
    `Tentatives : ${mission.repairs?.length ?? 0}. Politique de test : ${mission.testPolicy ?? 'deny'}.`,
    `Jetons additionnés : ${tokens.input} entrée / ${tokens.output} sortie. Ce n’est pas une facture fournisseur.`,
    `Permissions : ${permissions || 'aucune'}.`,
    'Le succès n’est pas déclaré par le modèle.',
  ].join('\n');
}

export function suggestBranch(title: string, unique: string): string {
  const slug = title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || 'mission';
  const suffix = unique.replace(/[^a-z0-9]/giu, '').slice(0, 8).toLowerCase() || 'local';
  return `cortex/mission-${slug}-${suffix}`;
}

export function resumeBrief(mission: Mission & { verdict: MissionVerdict }, notes: ContextItem[] = [], budgetTokens = 1_200): ReturnType<typeof packContext> & { handoff: string } {
  const pending = mission.steps.filter((step) => step.status === 'pending' || step.status === 'failed').map((step) => step.title);
  const evidence = mission.evidence.at(-1);
  const handoff = modelHandoff({
    goal: mission.goal,
    fromProfileId: mission.profileId,
    toProfileId: mission.profileId,
    pending,
    evidence: evidence ? `${evidence.command} exit=${evidence.exitCode} timeout=${evidence.timedOut} truncated=${evidence.truncated}` : '',
  });
  const items: ContextItem[] = [
    { id: 'rule', kind: 'instruction', title: 'Règle de clôture', text: PROOF_RULE },
    { id: 'handoff', kind: 'handoff', title: 'Reprise', text: handoff },
    { id: 'verdict', kind: 'evidence', title: 'Verdict local', text: `${mission.verdict.status} complete=${mission.verdict.complete}\n${mission.verdict.reasons.join('\n')}` },
    { id: 'claims', kind: 'recent', title: 'Fichiers revendiqués', text: mission.claims.map((claim) => `${claim.agentId}: ${claim.paths.join(', ')}`).join('\n') || 'Aucune revendication.' },
    ...notes,
  ];
  return { ...packContext(items, budgetTokens), handoff };
}

export function createMission(ctx: Context, p: Project, input: unknown): Mission & { verdict: MissionVerdict; suggestedBranch: string } {
  confirmed(input); trusted(p);
  const body = z.object({ title: label, goal: aiText, profileId: z.string().min(1).max(100), confirm: z.literal(true) }).strict().parse(input);
  requireProfile(ctx, body.profileId);
  const stamp = now();
  const mission: Mission = {
    id: id(), projectId: p.id, title: body.title, goal: redact(ctx, body.goal), profileId: body.profileId, status: 'active',
    steps: [
      { id: id(), title: 'Analyser le dépôt et borner le périmètre', kind: 'analyze', status: 'pending', required: true },
      { id: id(), title: 'Modifier uniquement les fichiers revendiqués', kind: 'edit', status: 'pending', required: true },
      { id: id(), title: 'Exécuter les tests et joindre la preuve', kind: 'test', status: 'pending', required: true },
      { id: id(), title: 'Revue du diff en lecture seule', kind: 'review', status: 'pending', required: false },
      { id: id(), title: 'Publier sur une branche cortex/ après accord', kind: 'publish', status: 'pending', required: false },
    ],
    claims: [], conflicts: [], evidence: [], repairs: [], createdAt: stamp, updatedAt: stamp, resumeCount: 0,
  };
  const view = save(ctx, mission);
  ctx.history(p.id, 'mission', 'Mission locale ouverte', `${view.id} : ${view.title}. Aucun modèle appelé.`);
  return { ...view, suggestedBranch: suggestBranch(view.title, view.id) };
}

export function updateMissionStep(ctx: Context, p: Project, missionId: string, input: unknown): Mission & { verdict: MissionVerdict } {
  confirmed(input); trusted(p);
  const body = z.object({ stepId: z.string().min(1), status: z.enum(['pending', 'done', 'skipped', 'failed']), confirm: z.literal(true) }).strict().parse(input);
  const mission = owned<Mission>(ctx, 'missions', missionId, p.id);
  if (mission.status === 'cancelled') throw new AdvancedError(409, 'MISSION_CLOSED', 'Mission annulée.');
  const step = mission.steps.find((item) => item.id === body.stepId);
  if (!step) throw new AdvancedError(404, 'STEP_NOT_FOUND', 'Étape inconnue.');
  if (body.status === 'skipped' && step.required) throw new AdvancedError(400, 'REQUIRED_STEP', 'Une étape obligatoire ne se saute pas.');
  if (step.kind === 'test' && body.status === 'done') throw new AdvancedError(409, 'EVIDENCE_REQUIRED', 'L’étape de test ne se clôt qu’avec une commande kind:test réelle.');
  step.status = body.status;
  return save(ctx, mission);
}

export function updateMissionClaims(ctx: Context, p: Project, missionId: string, input: unknown): Mission & { verdict: MissionVerdict } {
  confirmed(input); trusted(p);
  const body = z.object({
    claims: z.array(z.object({ agentId: z.string().trim().min(1).max(80), paths: z.array(z.string().min(1).max(500)).max(80) }).strict()).max(20),
    confirm: z.literal(true),
  }).strict().parse(input);
  const mission = owned<Mission>(ctx, 'missions', missionId, p.id);
  if (mission.status === 'cancelled') throw new AdvancedError(409, 'MISSION_CLOSED', 'Mission annulée.');
  const paths = body.claims.flatMap((claim) => claim.paths);
  const gate = authorizeOperation(ctx, p, missionId, { source: 'user', action: 'write', paths });
  if (!gate.allowed) throw new AdvancedError(409, gate.code, gate.reason);
  mission.claims = body.claims;
  mission.conflicts = detectClaimConflicts(body.claims);
  const view = save(ctx, mission);
  ctx.history(p.id, 'mission-claims', view.conflicts.length ? 'Conflits de fichiers détectés' : 'Revendications sans conflit', view.conflicts.map((conflict) => conflict.path).join(', ') || 'ok');
  return view;
}

export function attachTestEvidence(ctx: Context, p: Project, missionId: string, input: unknown): Mission & { verdict: MissionVerdict } {
  confirmed(input); trusted(p);
  const body = z.object({ commandId: z.string().min(1), confirm: z.literal(true) }).strict().parse(input);
  const mission = owned<Mission>(ctx, 'missions', missionId, p.id);
  if (mission.status === 'cancelled') throw new AdvancedError(409, 'MISSION_CLOSED', 'Mission annulée.');
  const command = owned<StoredCommand>(ctx, 'commands', body.commandId, p.id);
  if (command.kind !== 'test') throw new AdvancedError(409, 'NOT_A_TEST', 'Seule une commande enregistrée avec kind:test est une preuve.');
  mission.evidence.push({ id: id(), commandId: command.id, command: command.command, exitCode: command.exitCode, timedOut: command.timedOut, truncated: command.truncated, createdAt: command.createdAt });
  const view = save(ctx, mission);
  ctx.history(p.id, 'mission-evidence', 'Preuve de test attachée', `${command.id} exit=${command.exitCode}; verdict=${view.verdict.status}`);
  return view;
}

export function resumeMission(ctx: Context, p: Project, missionId: string, input: unknown): { mission: Mission & { verdict: MissionVerdict }; brief: string; estimatedTokens: number; truncated: boolean; submitted: false } {
  const body = z.object({ budgetTokens: z.number().int().min(32).max(12_000).optional(), note: z.string().trim().max(4_000).optional() }).strict().parse(input ?? {});
  const mission = owned<Mission>(ctx, 'missions', missionId, p.id);
  const profile = ctx.store.get<Profile>('profiles', mission.profileId);
  if (!profile) throw new AdvancedError(404, 'PROFILE_NOT_FOUND', 'Profil de la mission introuvable.');
  mission.resumeCount += 1;
  const view = save(ctx, mission);
  const notes = body.note ? [{ id: 'note', kind: 'recent' as const, title: 'Note de reprise', text: redact(ctx, body.note) }] : [];
  const packed = resumeBrief(view, notes, body.budgetTokens ?? 1_200);
  ctx.history(p.id, 'mission-resume', 'Brief de reprise préparé sans appel modèle', `${view.id} tokens≈${packed.estimatedTokens} tronqué=${packed.truncated}`);
  return { mission: view, brief: packed.text, estimatedTokens: packed.estimatedTokens, truncated: packed.truncated, submitted: false };
}

export function cancelMission(ctx: Context, p: Project, missionId: string, input: unknown): Mission & { verdict: MissionVerdict } {
  confirmed(input); trusted(p);
  z.object({ confirm: z.literal(true) }).strict().parse(input);
  const mission = owned<Mission>(ctx, 'missions', missionId, p.id);
  mission.status = 'cancelled';
  const view = save(ctx, mission);
  ctx.history(p.id, 'mission-cancel', 'Mission annulée', mission.id);
  return view;
}

export function registerMissionRoutes(app: Express, ctx: Context): void {
  const base = '/api/projects/:id/missions';
  app.get(base, route(ctx, (req, res) => {
    const p = project(ctx, req);
    res.json(all<Mission>(ctx, 'missions', p.id).map((mission) => presentMission(mission)));
  }));
  app.post(base, route(ctx, (req, res) => res.status(201).json(createMission(ctx, project(ctx, req), req.body))));
  app.get(`${base}/:missionId`, route(ctx, (req, res) => {
    const p = project(ctx, req);
    const mission = owned<Mission>(ctx, 'missions', param(req, 'missionId'), p.id);
    res.json(presentMission(mission));
  }));
  app.post(`${base}/:missionId/steps`, route(ctx, (req, res) => res.json(updateMissionStep(ctx, project(ctx, req), param(req, 'missionId'), req.body))));
  app.post(`${base}/:missionId/claims`, route(ctx, (req, res) => res.json(updateMissionClaims(ctx, project(ctx, req), param(req, 'missionId'), req.body))));
  app.post(`${base}/:missionId/evidence`, route(ctx, (req, res) => res.json(attachTestEvidence(ctx, project(ctx, req), param(req, 'missionId'), req.body))));
  app.post(`${base}/:missionId/resume`, route(ctx, (req, res) => res.json(resumeMission(ctx, project(ctx, req), param(req, 'missionId'), req.body))));
  app.post(`${base}/:missionId/cancel`, route(ctx, (req, res) => res.json(cancelMission(ctx, project(ctx, req), param(req, 'missionId'), req.body))));
}
