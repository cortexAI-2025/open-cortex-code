import type { Express } from 'express';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import type { CtoAgentInfo, CtoConnection, CtoEventView, CtoMissionLink, CtoMissionView, CtoReportView, CtoRuntimeInfo, CtoSpecialistRole, CtoTaskView, CtoTeam } from '../../shared/contracts.js';
import { HttpError, validateBaseUrl } from '../security.js';
import { AdvancedError, type Context, confirmed, id, now, owned, param, project, route, trusted, withProjectLock } from './common.js';

/**
 * Pont Open Cortex Code ↔ CTO IA (dépôt CTO-AI-AIWORKPAY).
 *
 * - Le CTO reste un processus indépendant : il possède l'orchestration, la délégation, les tests et la revue.
 *   Ce module ne planifie, ne délègue et n'exécute rien lui-même : il transmet, suit, présente et fait approuver.
 * - Authentification serveur à serveur : `CORTEX_CTO_URL` (HTTPS ou loopback) + `CORTEX_CTO_TOKEN` (bearer, 24+ car.).
 *   Le jeton n'est jamais renvoyé au navigateur, jamais persisté (le coffre mémoire le masque) et jamais transmis aux agents.
 * - Correspondance persistante des identifiants : `cto-missions` (id Open Cortex = clé d'idempotence `external_ref` du CTO).
 *   Une même mission ne peut donc être créée qu'une fois côté CTO, même après un échec réseau ou un redémarrage.
 */

const KIND = 'cto-missions';
const EVENTS = 'cto-events';
const SUPERVISOR = 'cto-supervisor';
const ROLES: CtoSpecialistRole[] = ['architect', 'backend', 'qa', 'security'];
const LABELS: Record<CtoSpecialistRole, string> = { architect: 'Architecte', backend: 'Backend', qa: 'QA', security: 'Sécurité' };
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const TIMEOUT_MS = 10_000;
const MAX_OBJECTIVE = 2000;

interface CtoConfig { url: string; token: string }
interface CtoMission { id: string; status: string; budget_usd: number; spent_usd: number; estimated_usd?: number; blockers?: string[]; tasks: Array<Record<string, unknown>>; reports: Array<Record<string, unknown>>; external_ref?: string | null }

function config(ctx: Context): CtoConfig | null {
  const rawUrl = process.env.CORTEX_CTO_URL?.trim();
  const token = process.env.CORTEX_CTO_TOKEN?.trim();
  if (!rawUrl || !token) return null;
  if (token.length < 24 || /[\s\0]/u.test(token)) throw new AdvancedError(503, 'CTO_CONFIG_INVALID', 'CORTEX_CTO_TOKEN invalide (24 caractères minimum, sans espace).');
  let url: string;
  try { url = validateBaseUrl(rawUrl); } catch (error) { throw new AdvancedError(503, 'CTO_CONFIG_INVALID', error instanceof HttpError ? 'CORTEX_CTO_URL doit être HTTPS ou loopback, sans identifiants.' : 'CORTEX_CTO_URL invalide.'); }
  ctx.vault.set('cto-token', token); // masque le jeton dans toute réponse, journal et enregistrement
  return { url, token };
}
function requireConfig(ctx: Context): CtoConfig {
  const cfg = config(ctx);
  if (!cfg) throw new AdvancedError(503, 'CTO_NOT_CONFIGURED', 'CTO IA non configuré : définir CORTEX_CTO_URL et CORTEX_CTO_TOKEN côté connecteur (jamais dans le navigateur).');
  return cfg;
}

/** Appel serveur à serveur. Les erreurs sont explicites et typées ; aucune réponse n'est inventée. */
async function cto<T>(ctx: Context, method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const cfg = requireConfig(ctx);
  let response: Response;
  try {
    response = await fetch(`${cfg.url}${path}`, {
      method, redirect: 'error', signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new AdvancedError(502, 'CTO_UNREACHABLE', 'CTO IA injoignable ou délai dépassé. Rien n’a été présumé réussi.'); }
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { if (response.ok) throw new AdvancedError(502, 'CTO_BAD_RESPONSE', 'Réponse du CTO IA non JSON.'); }
  if (response.ok) return json as T;
  const message = typeof json.error === 'string' ? json.error : `HTTP ${response.status}`;
  if (response.status === 403 && /read-only/iu.test(message)) throw new AdvancedError(403, 'CTO_READ_ONLY', 'Le jeton CTO configuré est en lecture seule : action refusée.');
  if (response.status === 401 || response.status === 403 && /token|unauthor/iu.test(message)) throw new AdvancedError(502, 'CTO_AUTH_FAILED', 'CTO IA : authentification serveur à serveur refusée. Vérifier CORTEX_CTO_TOKEN.');
  if (response.status === 403) throw new AdvancedError(403, 'CTO_READ_ONLY', 'Le jeton CTO configuré est en lecture seule : action refusée.');
  if (response.status === 409 && json.status === 'BLOCKED') throw new AdvancedError(409, 'CTO_BLOCKED', message, { blocked: true });
  if (response.status === 404) throw new AdvancedError(404, 'CTO_NOT_FOUND', 'Mission introuvable côté CTO IA.');
  if (response.status === 429) throw new AdvancedError(429, 'CTO_RATE_LIMITED', 'CTO IA : trop de requêtes, réessayer plus tard.');
  if (response.status >= 500) throw new AdvancedError(502, 'CTO_ERROR', 'Erreur interne du CTO IA.');
  throw new AdvancedError(response.status === 409 ? 409 : 400, 'CTO_REJECTED', message);
}

// ------------------------------------------------------------------ vues

function runtimeView(raw: { api?: string; repo_path?: string; preflight?: { ok: boolean; status: string; blockers: string[]; isolation: string; checks: Array<{ name: string; ok: boolean; detail: string }>; checked_at?: string } | null } | null): CtoRuntimeInfo {
  const pf = raw?.preflight;
  if (!raw) return { status: 'UNKNOWN', blockers: ['CTO IA non joint : isolation non vérifiable.'], isolation: 'unknown', containerCertified: false, checks: [] };
  if (!pf) return { status: 'UNKNOWN', blockers: ['Le CTO IA n’exécute aucune vérification d’isolation (CTO_PREFLIGHT=0) : exécution refusée.'], isolation: 'unverified', containerCertified: false, checks: [], ...(raw.repo_path ? { repoPath: raw.repo_path } : {}) };
  return {
    status: pf.ok ? 'READY' : 'BLOCKED', blockers: pf.blockers, isolation: pf.isolation, containerCertified: false,
    checks: pf.checks.map(({ name, ok, detail }) => ({ name, ok, detail })), ...(raw.repo_path ? { repoPath: raw.repo_path } : {}), ...(pf.checked_at ? { checkedAt: pf.checked_at } : {}),
  };
}

function taskView(task: Record<string, unknown>): CtoTaskView {
  return {
    id: String(task.id), role: task.role as CtoSpecialistRole, status: String(task.status), attempts: Number(task.attempts ?? 0),
    corrections: Number(task.corrections ?? 0), failures: Number(task.failures ?? 0), instruction: String(task.instruction ?? '').slice(0, 300),
  };
}
function reportViews(reports: Array<Record<string, unknown>>): CtoReportView[] {
  return reports.map((r) => {
    const inner = (r.report ?? {}) as { tests?: { passed: number; failed: number } };
    const evidence = (r.evidence ?? {}) as { branch?: string; commit?: string };
    return {
      id: String(r.id), role: r.role as CtoSpecialistRole, verdict: String(r.verdict), summary: String(r.summary ?? ''),
      problems: Array.isArray(r.problems) ? r.problems.slice(0, 5).map((p) => String(p).split('\n')[0]!.slice(0, 300)) : [],
      costUsd: Number(r.cost_usd ?? 0), costEstimated: r.cost_estimated === true,
      ...(inner.tests ? { tests: { passed: inner.tests.passed, failed: inner.tests.failed } } : {}),
      ...(evidence.branch ? { branch: evidence.branch } : {}), ...(evidence.commit ? { commit: evidence.commit } : {}), createdAt: String(r.created_at ?? ''),
    };
  });
}
type RawReport = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function reportView(raw: RawReport): NonNullable<CtoMissionView['report']> {
  const git = raw.git as null | { branch: string; commit: string; base_commit: string | null; files: string[]; diffstat: string };
  return {
    mission: raw.mission ?? {}, costByRole: raw.cost_by_role ?? {}, reviews: raw.reviews ?? [], tests: raw.tests ?? null, acceptanceTests: raw.acceptance_tests ?? null,
    git: git ? { branch: git.branch, commit: git.commit, baseCommit: git.base_commit, files: git.files, diffstat: git.diffstat, pushed: false, merged: false } : null,
    pullRequestBody: String(raw.pull_request_body ?? ''), corrections: Number(raw.corrections_requested ?? 0), reworkRounds: Number(raw.rework_rounds ?? 0),
  };
}

/** Les tests d'acceptation du propriétaire restent côté serveur (retransmission après reprise) et ne sont pas renvoyés au navigateur. */
const publicJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, item: unknown) => key === 'acceptanceTests' ? undefined : item)) as unknown;

type StoredLink = CtoMissionLink & { acceptanceTests?: Record<string, string> };
function link(ctx: Context, projectId: string, linkId: string): StoredLink { return owned<StoredLink>(ctx, KIND, linkId, projectId); }
function save<T extends StoredLink>(ctx: Context, value: T): T { return ctx.store.put(KIND, { ...value, updatedAt: now() }, value.projectId); }
function failure(error: unknown): { code: string; message: string; at: string } {
  const e = error as { code?: string; message?: string };
  return { code: e.code ?? 'CTO_ERROR', message: (e.message ?? 'Erreur').slice(0, 300), at: now() };
}
function storedEvents(ctx: Context, linkId: string, projectId: string): CtoEventView[] {
  return ctx.store.all<CtoEventView & { linkId: string; id: string }>(EVENTS, projectId).filter((e) => e.linkId === linkId)
    .map(({ linkId: _l, ...rest }) => rest).sort((a, b) => a.at.localeCompare(b.at)).slice(-200);
}

// ------------------------------------------------------- synchronisation

/** Retrouve une mission déjà acceptée par le CTO (reprise après échec réseau) sans en créer une seconde. */
async function lookup(ctx: Context, linkId: string): Promise<CtoMission | undefined> {
  const found = await cto<CtoMission[]>(ctx, 'GET', `/api/missions?external_ref=${encodeURIComponent(linkId)}`);
  return found[0];
}

function composeObjective(l: CtoMissionLink): string {
  const criteria = l.acceptanceCriteria.length ? `\n\nAcceptance criteria:\n${l.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}` : '';
  const text = `${l.objective}${criteria}`;
  if (text.length > MAX_OBJECTIVE) throw new AdvancedError(400, 'OBJECTIVE_TOO_LONG', `Objectif + critères : ${MAX_OBJECTIVE} caractères maximum (${text.length}).`);
  return text;
}

async function submit(ctx: Context, l: StoredLink, acceptanceTests: Record<string, string> | undefined): Promise<CtoMissionLink> {
  if (l.localState === 'cancelled') throw new AdvancedError(409, 'MISSION_CANCELLED', 'Mission annulée localement : aucune transmission.');
  const created = await cto<CtoMission>(ctx, 'POST', '/api/missions', {
    objective: composeObjective(l), project: l.repo, budget_usd: l.budgetUsd, external_ref: l.id,
    ...(l.scope.length ? { scope: l.scope } : {}), ...(acceptanceTests && Object.keys(acceptanceTests).length ? { acceptance: acceptanceTests } : {}),
  });
  return save(ctx, applyMission({ ...l, localState: 'linked', ctoMissionId: created.id }, created));
}

function applyMission<T extends CtoMissionLink>(l: T, m: CtoMission, pending?: string[]): T {
  const { lastError: _drop, ...rest } = l;
  return {
    ...rest, status: m.status, spentUsd: m.spent_usd, estimatedUsd: m.estimated_usd ?? 0, blockers: m.blockers ?? [],
    pendingApprovals: pending ?? ({ pending_approval: ['mission'], awaiting_owner: ['architecture'], review: ['completion'] } as Record<string, string[]>)[m.status] ?? [],
    syncedAt: now(), stale: false,
  } as unknown as T;
}

async function refresh(ctx: Context, l: CtoMissionLink): Promise<CtoMissionView> {
  if (!l.ctoMissionId) return { link: l, tasks: [], reports: [], events: storedEvents(ctx, l.id, l.projectId), report: null };
  try {
    const [mission, report, events] = await Promise.all([
      cto<CtoMission>(ctx, 'GET', `/api/missions/${l.ctoMissionId}`),
      cto<RawReport>(ctx, 'GET', `/api/missions/${l.ctoMissionId}/report`),
      cto<Array<{ id: string; type: string; actor: string; task_id?: string | null; detail: Record<string, unknown>; at: string }>>(ctx, 'GET', `/api/missions/${l.ctoMissionId}/events`),
    ]);
    for (const event of events) {
      ctx.store.put(EVENTS, { id: `${l.id}:${event.id}`, linkId: l.id, type: event.type, actor: event.actor, taskId: event.task_id ?? null, detail: event.detail, at: event.at }, l.projectId);
    }
    const saved = save(ctx, applyMission(l, mission, report.pending_approvals as string[] | undefined));
    return { link: saved, tasks: mission.tasks.map(taskView), reports: reportViews(mission.reports), events: storedEvents(ctx, l.id, l.projectId), report: reportView(report) };
  } catch (error) {
    // Dernier état connu, explicitement marqué périmé : jamais présenté comme actuel.
    const saved = save(ctx, { ...l, stale: true, lastError: failure(error) });
    return { link: saved, tasks: [], reports: [], events: storedEvents(ctx, l.id, l.projectId), report: null };
  }
}

// ------------------------------------------------------------- schémas

const repo = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/u, 'owner/repo requis');
const createSchema = z.object({
  idempotencyKey: z.string().uuid().optional(), repo, objective: z.string().trim().min(1).max(1500),
  budgetUsd: z.number().positive().max(50).default(3),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  acceptanceTests: z.record(z.string().regex(/^[A-Za-z0-9_.-]+\.test\.(c|m)?js$/u), z.string().max(20_000)).refine((v) => Object.keys(v).length <= 5).optional(),
  scope: z.array(z.string().trim().min(1).max(200)).max(20).default([]), confirm: z.literal(true),
}).strict();
const approvalSchema = z.object({ kind: z.enum(['mission', 'architecture', 'completion']), decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).optional(), confirm: z.literal(true) }).strict();
const confirmSchema = z.object({ confirm: z.literal(true) }).strict();

// -------------------------------------------------------------- équipe

async function team(ctx: Context): Promise<CtoTeam> {
  const base = { id: 'cto-ia' as const, name: 'CTO IA', role: 'supervisor' as const };
  const stored = ctx.store.get<{ registeredAt: string; lastSeenAt?: string }>(SUPERVISOR, 'cto-ia');
  const registered = { registered: Boolean(stored), ...(stored ? { registeredAt: stored.registeredAt } : {}) };
  let cfg: CtoConfig | null;
  try { cfg = config(ctx); } catch (error) {
    return { supervisor: { ...base, ...registered, connection: 'not_configured', error: failure(error) }, runtime: runtimeView(null), agents: ROLES.map((role) => unknownAgent(role)) };
  }
  if (!cfg) return { supervisor: { ...base, ...registered, connection: 'not_configured' }, runtime: runtimeView(null), agents: ROLES.map((role) => unknownAgent(role)) };
  const endpoint = new URL(cfg.url).origin;
  try {
    const [who, runtime, agents] = await Promise.all([
      cto<{ role: 'owner' | 'viewer' }>(ctx, 'GET', '/api/whoami'),
      cto<Parameters<typeof runtimeView>[0]>(ctx, 'GET', '/api/runtime'),
      cto<Array<{ role: CtoSpecialistRole; capabilities: string[]; read_only: boolean; max_budget_usd: number; state?: string; running_tasks: Array<{ id: string; mission_id: string }> }>>(ctx, 'GET', '/api/agents'),
    ]);
    const lastSeenAt = now();
    if (stored) ctx.store.put(SUPERVISOR, { id: 'cto-ia', ...stored, lastSeenAt });
    const infos: CtoAgentInfo[] = ROLES.map((role) => {
      const found = agents.find((a) => a.role === role);
      return found
        ? { role, label: LABELS[role], capabilities: found.capabilities, readOnly: found.read_only, maxBudgetUsd: found.max_budget_usd, state: found.state === 'busy' || found.running_tasks.length ? 'busy' : 'idle', runningTasks: found.running_tasks.map((t) => ({ id: t.id, missionId: t.mission_id })) }
        : unknownAgent(role);
    });
    return { supervisor: { ...base, ...registered, endpoint, connection: 'connected', accessRole: who.role, lastSeenAt }, runtime: runtimeView(runtime), agents: infos };
  } catch (error) {
    const code = (error as { code?: string }).code;
    const connection: CtoConnection = code === 'CTO_AUTH_FAILED' ? 'unauthorized' : 'unreachable';
    return { supervisor: { ...base, ...registered, endpoint, connection, error: failure(error), ...(stored?.lastSeenAt ? { lastSeenAt: stored.lastSeenAt } : {}) }, runtime: runtimeView(null), agents: ROLES.map((role) => unknownAgent(role)) };
  }
}
function unknownAgent(role: CtoSpecialistRole): CtoAgentInfo {
  return { role, label: LABELS[role], capabilities: [], readOnly: role !== 'backend', maxBudgetUsd: null, state: 'unknown', runningTasks: [] };
}

/** Vérifie que le CTO travaille bien sur le dépôt du projet Open Cortex et que l'isolation est réellement disponible. */
async function assertRunnable(ctx: Context, projectPath: string): Promise<void> {
  if ((await cto<{ role: string }>(ctx, 'GET', '/api/whoami')).role !== 'owner') throw new AdvancedError(403, 'CTO_READ_ONLY', 'Le jeton CTO configuré est en lecture seule : action refusée.');
  const runtime = await cto<{ repo_path?: string; preflight?: { ok: boolean; blockers: string[] } | null }>(ctx, 'GET', '/api/runtime?force=1');
  if (!runtime.preflight) throw new AdvancedError(409, 'CTO_BLOCKED', 'BLOCKED : le CTO IA ne vérifie pas son isolation (CTO_PREFLIGHT=0). Aucune exécution lancée.', { blocked: true, blockers: ['isolation non vérifiée'] });
  if (!runtime.preflight.ok) throw new AdvancedError(409, 'CTO_BLOCKED', `BLOCKED : ${runtime.preflight.blockers.join('; ')}`, { blocked: true, blockers: runtime.preflight.blockers });
  let expected: string;
  try { expected = realpathSync(projectPath); } catch { throw new AdvancedError(404, 'PROJECT_NOT_FOUND', 'Projet absent.'); }
  if (runtime.repo_path !== expected) throw new AdvancedError(409, 'CTO_REPO_MISMATCH', 'Le CTO IA travaille sur un autre dépôt que ce projet (CTO_REPO_PATH). Aucune mission transmise.');
}

export function registerCtoBridgeRoutes(app: Express, ctx: Context): void {
  app.get('/api/cto/team', route(ctx, async (_req, res) => { res.json(await team(ctx)); }));

  app.post('/api/cto/register', route(ctx, async (req, res) => {
    confirmed(req.body);
    const t = await team(ctx);
    if (t.supervisor.connection !== 'connected') throw new AdvancedError(502, t.supervisor.error?.code ?? 'CTO_UNREACHABLE', t.supervisor.error?.message ?? 'CTO IA non joint : enregistrement refusé.');
    const missing = t.agents.filter((a) => a.state === 'unknown').map((a) => a.role);
    if (missing.length) throw new AdvancedError(409, 'CTO_AGENTS_MISSING', `Spécialistes absents côté CTO : ${missing.join(', ')}.`);
    const previous = ctx.store.get<{ registeredAt: string }>(SUPERVISOR, 'cto-ia');
    ctx.store.put(SUPERVISOR, { id: 'cto-ia', name: 'CTO IA', role: 'supervisor', endpoint: t.supervisor.endpoint, specialists: ROLES, registeredAt: previous?.registeredAt ?? now(), lastSeenAt: now() });
    res.json(await team(ctx));
  }));

  app.get('/api/projects/:id/cto/missions', route(ctx, async (req, res) => {
    const p = project(ctx, req);
    const links = ctx.store.all<CtoMissionLink>(KIND, p.id).filter((l) => l.projectId === p.id);
    const active = links.filter((l) => l.localState !== 'cancelled' && !TERMINAL.has(l.status)).slice(-10);
    // Rafraîchissement au mieux ; en cas d'échec le dernier état connu reste, marqué périmé.
    const refreshed = new Map((await Promise.all(active.map((l) => withProjectLock(`cto:${l.id}`, async () => (await refresh(ctx, link(ctx, p.id, l.id))).link)))).map((l) => [l.id, l]));
    res.json(publicJson(links.map((l) => refreshed.get(l.id) ?? l).reverse()));
  }));

  app.post('/api/projects/:id/cto/missions', route(ctx, async (req, res) => {
    const p = project(ctx, req); trusted(p); confirmed(req.body);
    const input = createSchema.parse(req.body);
    const linkId = input.idempotencyKey ?? id();
    const created = await withProjectLock(`cto:${linkId}`, async () => {
      const existing = ctx.store.get<CtoMissionLink>(KIND, linkId);
      if (existing) {
        if (existing.projectId !== p.id) throw new AdvancedError(409, 'IDEMPOTENCY_CONFLICT', 'Clé d’idempotence déjà utilisée par un autre projet.');
        return { link: existing, replay: true };
      }
      await assertRunnable(ctx, p.path);
      const draft: StoredLink = {
        id: linkId, projectId: p.id, repo: input.repo, objective: input.objective, acceptanceCriteria: input.acceptanceCriteria, scope: input.scope, budgetUsd: input.budgetUsd,
        ...(input.acceptanceTests ? { acceptanceTests: input.acceptanceTests } : {}),
        localState: 'submitting', status: 'submitting', pendingApprovals: [], blockers: [], spentUsd: 0, estimatedUsd: 0, createdAt: now(), updatedAt: now(),
      };
      composeObjective(draft);
      save(ctx, draft); // persisté AVANT l'envoi : une coupure réseau laisse une trace reprenable, jamais un doublon
      ctx.history(p.id, 'cto-mission', 'Mission transmise au CTO IA', `${linkId} · ${input.repo} · budget ${input.budgetUsd} USD`);
      try { return { link: await submit(ctx, draft, draft.acceptanceTests), replay: false }; }
      catch (error) {
        save(ctx, { ...draft, lastError: failure(error) });
        const e = error as AdvancedError;
        throw new AdvancedError(e.status ?? 502, e.code ?? 'CTO_ERROR', `${e.message} Mission enregistrée localement (${linkId}) : « Reprendre » la retransmet sans doublon.`, { missionId: linkId });
      }
    });
    res.status(created.replay ? 200 : 201).json(publicJson(created.replay ? await withProjectLock(`cto:${linkId}`, () => refresh(ctx, link(ctx, p.id, linkId))) : await refresh(ctx, created.link)));
  }));

  app.get('/api/projects/:id/cto/missions/:missionId', route(ctx, async (req, res) => {
    const p = project(ctx, req);
    res.json(publicJson(await withProjectLock(`cto:${param(req, 'missionId')}`, () => refresh(ctx, link(ctx, p.id, param(req, 'missionId'))))));
  }));

  app.post('/api/projects/:id/cto/missions/:missionId/approvals', route(ctx, async (req, res) => {
    const p = project(ctx, req); trusted(p); confirmed(req.body);
    const input = approvalSchema.parse(req.body);
    const linkId = param(req, 'missionId');
    res.json(publicJson(await withProjectLock(`cto:${linkId}`, async () => {
      const view = await refresh(ctx, link(ctx, p.id, linkId));
      if (view.link.stale || !view.link.ctoMissionId) throw new AdvancedError(502, 'CTO_UNREACHABLE', 'État CTO indisponible : approbation refusée sur un état périmé.');
      if (!view.link.pendingApprovals.includes(input.kind)) throw new AdvancedError(409, 'APPROVAL_NOT_PENDING', `Aucune approbation « ${input.kind} » n’est demandée (état : ${view.link.status}).`);
      await cto(ctx, 'POST', `/api/missions/${view.link.ctoMissionId}/approvals`, { kind: input.kind, decision: input.decision, note: `${input.note ?? ''} [via Open Cortex Code]`.trim() });
      ctx.history(p.id, 'cto-approval', `Approbation ${input.kind} : ${input.decision}`, linkId);
      return refresh(ctx, link(ctx, p.id, linkId));
    })));
  }));

  app.post('/api/projects/:id/cto/missions/:missionId/cancel', route(ctx, async (req, res) => {
    const p = project(ctx, req); confirmed(req.body); confirmSchema.parse(req.body);
    const linkId = param(req, 'missionId');
    res.json(publicJson(await withProjectLock(`cto:${linkId}`, async () => {
      let l = link(ctx, p.id, linkId);
      if (l.localState === 'cancelled' || l.status === 'cancelled') return refresh(ctx, l);
      if (!l.ctoMissionId) { // jamais arrivée au CTO ? le vérifier avant de conclure
        const found = await lookup(ctx, l.id);
        if (found) l = save(ctx, applyMission({ ...l, localState: 'linked', ctoMissionId: found.id }, found));
        else { ctx.history(p.id, 'cto-cancel', 'Mission annulée avant transmission', linkId); return { link: save(ctx, { ...l, localState: 'cancelled', status: 'cancelled' }), tasks: [], reports: [], events: [], report: null } satisfies CtoMissionView; }
      }
      if (TERMINAL.has(l.status) && l.status !== 'cancelled') throw new AdvancedError(409, 'MISSION_FINISHED', `Mission déjà ${l.status}.`);
      await cto(ctx, 'POST', `/api/missions/${l.ctoMissionId}/cancel`, { reason: 'cancelled from Open Cortex Code' });
      ctx.history(p.id, 'cto-cancel', 'Mission CTO annulée', linkId);
      return refresh(ctx, link(ctx, p.id, linkId));
    })));
  }));

  app.post('/api/projects/:id/cto/missions/:missionId/resume', route(ctx, async (req, res) => {
    const p = project(ctx, req); trusted(p); confirmed(req.body); confirmSchema.parse(req.body);
    const linkId = param(req, 'missionId');
    res.json(publicJson(await withProjectLock(`cto:${linkId}`, async () => {
      let l = link(ctx, p.id, linkId);
      if (l.localState === 'cancelled' || l.status === 'cancelled') throw new AdvancedError(409, 'MISSION_CANCELLED', 'Mission annulée : reprise impossible.');
      if (!l.ctoMissionId) {
        // Réconciliation avant tout renvoi : si le CTO l'a déjà acceptée, on la rattache, on ne la recrée pas.
        const found = await lookup(ctx, l.id);
        if (found) l = save(ctx, applyMission({ ...l, localState: 'linked', ctoMissionId: found.id }, found));
        else { await assertRunnable(ctx, p.path); l = await submit(ctx, l, l.acceptanceTests); }
      } else {
        const current = await cto<CtoMission>(ctx, 'GET', `/api/missions/${l.ctoMissionId}`);
        if (current.status === 'blocked') await cto(ctx, 'POST', `/api/missions/${l.ctoMissionId}/resume`, {});
        else if (current.status === 'approved' || current.status === 'running') await cto(ctx, 'POST', `/api/missions/${l.ctoMissionId}/run`, {}); // au plus un bail par tâche côté CTO
      }
      ctx.history(p.id, 'cto-resume', 'Reprise de mission CTO', linkId);
      return refresh(ctx, link(ctx, p.id, linkId));
    })));
  }));
}
