import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import type { Project } from '../shared/contracts.js';
import { Store } from '../server/store.js';
import { Vault } from '../server/vault.js';
import type { Context } from '../server/advanced/common.js';
import { registerCtoBridgeRoutes } from '../server/advanced/cto-bridge.js';

const TOKEN = 'cto-owner-token-0123456789-abcdefghij';
const VIEWER = 'cto-viewer-token-0123456789-abcdefghij';

/**
 * Double de contrat du CTO IA (API HTTP documentée dans CTO-AI-AIWORKPAY). Il ne simule aucun travail d'agent :
 * il sert à éprouver le pont (idempotence, coupures, reprise, secrets). Le vrai CTO est exercé par le test « CTO réel » ci-dessous
 * (CTO_REPO_DIR) et par la mission pilote.
 */
class FakeCto {
  server!: Server; url = '';
  missions: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  events: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  repoPath = '';
  preflight: Record<string, any> | null = { ok: true, status: 'READY', blockers: [], isolation: 'bubblewrap-namespaces', checks: [{ name: 'bubblewrap_isolation', ok: true, detail: 'ok' }], container_certified: false };
  dropNextCreateResponse = false;
  rejectNextCreate = false;
  creates = 0;
  down = false;
  async start(): Promise<void> {
    this.server = http.createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  stop(): Promise<void> { return new Promise((resolve) => { this.server.close(() => resolve()); this.server.closeAllConnections(); }); }
  event(missionId: string, type: string, detail: Record<string, unknown> = {}): void { this.events.push({ id: `e${this.events.length + 1}-${'0'.repeat(30)}`, mission_id: missionId, task_id: null, type, actor: 'cto', detail, at: new Date().toISOString() }); }
  private send(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.down) { req.socket.destroy(); return; }
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${TOKEN}` && auth !== `Bearer ${VIEWER}`) return this.send(res, 401, { error: 'Unauthorized' });
    const viewer = auth === `Bearer ${VIEWER}`;
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any> : {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (req.method !== 'GET' && viewer) return this.send(res, 403, { error: 'Read-only token' });
    const p = url.pathname;
    if (p === '/api/whoami') return this.send(res, 200, { role: viewer ? 'viewer' : 'owner' });
    if (p === '/api/runtime') return this.send(res, 200, { api: 'cto-ai/1', repo_path: this.repoPath, preflight: this.preflight });
    if (p === '/api/agents') return this.send(res, 200, ['architect', 'backend', 'qa', 'security'].map((role) => ({ role, capabilities: ['x'], read_only: role !== 'backend', max_budget_usd: 1, state: 'idle', running_tasks: [] })));
    if (p === '/api/missions' && req.method === 'GET') {
      const ref = url.searchParams.get('external_ref');
      return this.send(res, 200, ref ? this.missions.filter((m) => m.external_ref === ref) : this.missions);
    }
    if (p === '/api/missions' && req.method === 'POST') {
      if (this.rejectNextCreate) { this.rejectNextCreate = false; req.socket.destroy(); return; } // coupure AVANT acceptation
      let m = this.missions.find((x) => x.external_ref === body.external_ref);
      if (!m) {
        this.creates += 1;
        m = { id: `00000000-0000-4000-8000-${String(this.missions.length + 1).padStart(12, '0')}`, status: 'pending_approval', budget_usd: body.budget_usd, spent_usd: 0, estimated_usd: 0, external_ref: body.external_ref, objective: body.objective, scope: body.scope ?? null, acceptance: body.acceptance ?? null, project: body.project, blockers: [], tasks: ['architect', 'backend', 'qa', 'security'].map((role, i) => ({ id: `t${i}`, role, status: role === 'architect' ? 'queued' : 'waiting', attempts: 0, corrections: 0, failures: 0, instruction: `${role} task` })), reports: [] };
        this.missions.push(m); this.event(m.id, 'mission_created');
      }
      if (this.dropNextCreateResponse) { this.dropNextCreateResponse = false; req.socket.destroy(); return; }
      return this.send(res, 201, m);
    }
    const match = p.match(/^\/api\/missions\/([^/]+)(?:\/([a-z]+))?$/);
    const m = match ? this.missions.find((x) => x.id === match[1]) : undefined;
    if (!match || !m) return this.send(res, 404, { error: 'Not found' });
    const action = match[2];
    if (!action) return this.send(res, 200, m);
    if (action === 'events') return this.send(res, 200, this.events.filter((e) => e.mission_id === m.id));
    if (action === 'report') return this.send(res, 200, { mission: { id: m.id, status: m.status, budget_usd: m.budget_usd, spent_usd: m.spent_usd }, cost_by_role: { architect: 0.05 }, reviews: [], pending_approvals: ({ pending_approval: ['mission'], awaiting_owner: ['architecture'], review: ['completion'] } as Record<string, string[]>)[m.status] ?? [], git: m.git ?? null, tests: null, acceptance_tests: null, pull_request_body: '## Objective', corrections_requested: 0, rework_rounds: 0 });
    if (action === 'approvals') {
      const need = { pending_approval: 'mission', awaiting_owner: 'architecture', review: 'completion' }[m.status as string];
      if (need !== body.kind) return this.send(res, 400, { error: `Cannot record a ${body.kind} approval while the mission is ${m.status}` });
      m.status = body.decision === 'reject' ? 'cancelled' : ({ mission: 'approved', architecture: 'running', completion: 'completed' } as Record<string, string>)[body.kind as string];
      this.event(m.id, 'approval_recorded', { kind: body.kind, decision: body.decision, note: body.note });
      return this.send(res, 200, m);
    }
    if (action === 'cancel') { m.status = 'cancelled'; this.event(m.id, 'mission_cancelled'); return this.send(res, 200, m); }
    if (action === 'resume') {
      if (m.status === 'blocked' && this.preflight && !this.preflight.ok) return this.send(res, 409, { error: `BLOCKED: ${this.preflight.blockers.join('; ')}`, status: 'BLOCKED' });
      if (m.status === 'blocked') m.status = 'running';
      return this.send(res, 200, m);
    }
    if (action === 'run') return this.send(res, 202, { started: 0 });
    return this.send(res, 404, { error: 'Not found' });
  }
}

let root = ''; let fake: FakeCto; let store: Store; let vault: Vault; let ctx: Context; let project: Project; let appServer: Server; let base = '';
const saved = { url: process.env.CORTEX_CTO_URL, token: process.env.CORTEX_CTO_TOKEN };

async function boot(): Promise<void> {
  vault = new Vault();
  store = new Store(path.join(root, 'data', 'cortex.sqlite'), (json) => JSON.stringify(vault.redactValue(JSON.parse(json))));
  store.put('projects', project);
  ctx = {
    store, vault, engine: { request: async () => undefined }, project: (id: string) => { const item = store.get<Project>('projects', id); if (!item) throw Object.assign(new Error('absent'), { status: 404, code: 'NOT_FOUND' }); return item; },
    createSession: async () => { throw new Error('inutilisé'); }, prompt: async () => ({ accepted: true }),
    history: (projectId: string, kind: string, title: string, detail: string) => store.put('history', { id: `${kind}-${Math.random()}`, projectId, kind, title, detail, createdAt: new Date().toISOString() }, projectId),
  } as unknown as Context;
  const app = express(); app.use(express.json());
  registerCtoBridgeRoutes(app, ctx);
  await new Promise<void>((resolve) => { appServer = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(appServer.address() as { port: number }).port}`;
}
async function shutdown(): Promise<void> { await new Promise<void>((resolve) => { appServer.close(() => resolve()); appServer.closeAllConnections(); }); store.close(); }

async function api(method: string, route: string, body?: unknown): Promise<{ status: number; body: any; text: string }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const response = await fetch(`${base}${route}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
}
const P = () => `/api/projects/${project.id}/cto/missions`;
const newMission = (extra: Record<string, unknown> = {}) => ({ repo: 'owner/repo', objective: 'Ajouter slugify avec tests', budgetUsd: 2, acceptanceCriteria: ['slugify("A b") === "a-b"'], scope: ['src', 'test'], confirm: true, ...extra });

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cto-bridge-'));
  const repoPath = path.join(root, 'repo'); await mkdir(repoPath);
  const real = await realpath(repoPath);
  project = { id: 'p1', name: 'repo', path: real, trusted: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  fake = new FakeCto(); fake.repoPath = real; await fake.start();
  process.env.CORTEX_CTO_URL = fake.url; process.env.CORTEX_CTO_TOKEN = TOKEN;
  await boot();
});
afterEach(async () => {
  await shutdown(); await fake.stop(); await rm(root, { recursive: true, force: true });
  for (const [key, value] of [['CORTEX_CTO_URL', saved.url], ['CORTEX_CTO_TOKEN', saved.token]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

describe('équipe IA : connexion, agents, enregistrement', () => {
  it('sans configuration : not_configured, quatre agents « unknown », rien de présumé', async () => {
    delete process.env.CORTEX_CTO_URL; delete process.env.CORTEX_CTO_TOKEN;
    const team = (await api('GET', '/api/cto/team')).body;
    expect(team.supervisor.connection).toBe('not_configured');
    expect(team.runtime.status).toBe('UNKNOWN');
    expect(team.agents.map((a: any) => `${a.role}:${a.state}`)).toEqual(['architect:unknown', 'backend:unknown', 'qa:unknown', 'security:unknown']); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await api('POST', P(), newMission())).body.code).toBe('CTO_NOT_CONFIGURED');
  });
  it('connecté : superviseur, quatre spécialistes réels, runtime READY, jamais « certifié »', async () => {
    const team = (await api('GET', '/api/cto/team')).body;
    expect(team.supervisor).toMatchObject({ connection: 'connected', accessRole: 'owner', registered: false, endpoint: fake.url });
    expect(team.agents.map((a: any) => a.role)).toEqual(['architect', 'backend', 'qa', 'security']); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(team.agents.every((a: any) => a.state === 'idle')).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(team.runtime).toMatchObject({ status: 'READY', isolation: 'bubblewrap-namespaces', containerCertified: false });
  });
  it('enregistrement : confirmation obligatoire, persistant, refusé si le CTO est absent', async () => {
    expect((await api('POST', '/api/cto/register', {})).body.code).toBe('CONFIRM_REQUIRED');
    const registered = (await api('POST', '/api/cto/register', { confirm: true })).body;
    expect(registered.supervisor.registered).toBe(true);
    expect(store.get('cto-supervisor', 'cto-ia')).toMatchObject({ role: 'supervisor', specialists: ['architect', 'backend', 'qa', 'security'] });
    fake.down = true;
    const refused = await api('POST', '/api/cto/register', { confirm: true });
    expect(refused.status).toBe(502); expect(refused.body.code).toBe('CTO_UNREACHABLE');
  });
  it('jeton refusé → unauthorized ; CTO coupé → unreachable', async () => {
    process.env.CORTEX_CTO_TOKEN = 'wrong-token-0123456789-abcdefghijkl';
    expect((await api('GET', '/api/cto/team')).body.supervisor).toMatchObject({ connection: 'unauthorized', error: { code: 'CTO_AUTH_FAILED' } });
    process.env.CORTEX_CTO_TOKEN = TOKEN; fake.down = true;
    expect((await api('GET', '/api/cto/team')).body.supervisor.connection).toBe('unreachable');
  });
  it('refuse une URL non sûre et un jeton trop court', async () => {
    process.env.CORTEX_CTO_URL = 'http://cto.example.com:3000';
    expect((await api('GET', '/api/cto/team')).body.supervisor.error.code).toBe('CTO_CONFIG_INVALID');
    process.env.CORTEX_CTO_URL = fake.url; process.env.CORTEX_CTO_TOKEN = 'short';
    expect((await api('GET', '/api/cto/team')).body.supervisor.error.code).toBe('CTO_CONFIG_INVALID');
  });
});

describe('transmission de mission', () => {
  it('crée, persiste la correspondance, transmet external_ref/périmètre/budget et ne fuit aucun secret', async () => {
    const response = await api('POST', P(), newMission({ idempotencyKey: '11111111-1111-4111-8111-111111111111' }));
    expect(response.status).toBe(201);
    const view = response.body;
    expect(view.link).toMatchObject({ id: '11111111-1111-4111-8111-111111111111', localState: 'linked', status: 'pending_approval', pendingApprovals: ['mission'], budgetUsd: 2, scope: ['src', 'test'] });
    expect(fake.missions).toHaveLength(1);
    expect(fake.missions[0]).toMatchObject({ external_ref: view.link.id, scope: ['src', 'test'], budget_usd: 2, project: 'owner/repo' });
    expect(fake.missions[0]!.objective).toContain('Acceptance criteria:\n- slugify("A b") === "a-b"');
    expect(view.tasks.map((t: any) => t.role)).toEqual(['architect', 'backend', 'qa', 'security']); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(view.events.map((e: any) => e.type)).toContain('mission_created'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(store.get('cto-missions', view.link.id)).toMatchObject({ ctoMissionId: fake.missions[0]!.id, projectId: 'p1' });
    const everything = [response.text, (await api('GET', '/api/cto/team')).text, (await api('GET', P())).text, JSON.stringify(store.all('cto-missions')), JSON.stringify(store.all('history'))].join('\n');
    expect(everything).not.toContain(TOKEN);
  });
  it('est idempotente : même clé → même mission, un seul envoi au CTO, même en parallèle', async () => {
    const body = newMission({ idempotencyKey: '22222222-2222-4222-8222-222222222222' });
    const results = await Promise.all([api('POST', P(), body), api('POST', P(), body), api('POST', P(), body)]);
    expect(new Set(results.map((r) => r.body.link.id)).size).toBe(1);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(fake.creates).toBe(1); expect(fake.missions).toHaveLength(1);
  });
  it('refuse : confirmation absente, projet non approuvé, dépôt différent, objectif trop long, clé réutilisée ailleurs', async () => {
    expect((await api('POST', P(), { ...newMission(), confirm: undefined })).status).toBe(403);
    store.put('projects', { ...project, trusted: false });
    expect((await api('POST', P(), newMission())).body.code).toBe('UNTRUSTED_PROJECT');
    store.put('projects', project);
    fake.repoPath = '/somewhere/else';
    expect((await api('POST', P(), newMission())).body.code).toBe('CTO_REPO_MISMATCH');
    fake.repoPath = project.path;
    expect((await api('POST', P(), newMission({ objective: 'x'.repeat(1500), acceptanceCriteria: ['y'.repeat(300), 'z'.repeat(300)] }))).body.code).toBe('OBJECTIVE_TOO_LONG');
    expect(fake.missions).toHaveLength(0);
    const key = '33333333-3333-4333-8333-333333333333';
    await api('POST', P(), newMission({ idempotencyKey: key }));
    store.put('projects', { ...project, id: 'p2', path: project.path });
    expect((await api('POST', '/api/projects/p2/cto/missions', newMission({ idempotencyKey: key }))).body.code).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('isolation indisponible ou non vérifiée → BLOCKED, rien n’est créé ni simulé', async () => {
    fake.preflight = { ok: false, status: 'BLOCKED', blockers: ['bubblewrap_isolation: bwrap not found'], isolation: 'unavailable', checks: [], container_certified: false };
    const blocked = await api('POST', P(), newMission());
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'CTO_BLOCKED', blocked: true });
    expect(blocked.body.error).toContain('BLOCKED');
    fake.preflight = null;
    expect((await api('POST', P(), newMission())).body.code).toBe('CTO_BLOCKED');
    expect(fake.missions).toHaveLength(0); expect(store.all('cto-missions')).toHaveLength(0);
    expect((await api('GET', '/api/cto/team')).body.runtime.status).toBe('UNKNOWN');
  });
});

describe('coupures, reprise et absence de doublon', () => {
  it('réponse perdue APRÈS acceptation par le CTO : la reprise rattache la mission existante, sans doublon', async () => {
    fake.dropNextCreateResponse = true;
    const lost = await api('POST', P(), newMission());
    expect(lost.status).toBe(502); expect(lost.body.code).toBe('CTO_UNREACHABLE');
    const stored = store.all<any>('cto-missions')[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(stored).toMatchObject({ localState: 'submitting' }); expect(stored.ctoMissionId).toBeUndefined();
    expect(fake.missions).toHaveLength(1);
    const resumed = await api('POST', `${P()}/${lost.body.missionId}/resume`, { confirm: true });
    expect(resumed.status).toBe(200);
    expect(resumed.body.link).toMatchObject({ localState: 'linked', ctoMissionId: fake.missions[0]!.id });
    expect(fake.missions).toHaveLength(1); expect(fake.creates).toBe(1);
  });
  it('CTO coupé AVANT acceptation : la reprise transmet une seule fois, même lancée deux fois en parallèle', async () => {
    fake.rejectNextCreate = true;
    const lost = await api('POST', P(), newMission());
    expect(lost.status).toBe(502);
    expect(fake.missions).toHaveLength(0);
    const [a, b] = await Promise.all([1, 2].map(() => api('POST', `${P()}/${lost.body.missionId}/resume`, { confirm: true })));
    expect([a!.status, b!.status]).toEqual([200, 200]);
    expect(fake.missions).toHaveLength(1); expect(fake.creates).toBe(1);
  });
  it('survit à un redémarrage du connecteur : correspondance persistante, aucun nouvel envoi', async () => {
    const created = (await api('POST', P(), newMission())).body;
    await shutdown(); await boot();
    const list = (await api('GET', P())).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: created.link.id, ctoMissionId: fake.missions[0]!.id });
    const resumed = await api('POST', `${P()}/${created.link.id}/resume`, { confirm: true });
    expect(resumed.status).toBe(200); expect(fake.creates).toBe(1);
  });
  it('CTO injoignable : dernier état connu, explicitement périmé, et approbation refusée sur état périmé', async () => {
    const created = (await api('POST', P(), newMission())).body;
    fake.down = true;
    const view = (await api('GET', `${P()}/${created.link.id}`)).body;
    expect(view.link).toMatchObject({ stale: true, status: 'pending_approval', lastError: { code: 'CTO_UNREACHABLE' } });
    const refused = await api('POST', `${P()}/${created.link.id}/approvals`, { kind: 'mission', decision: 'approve', confirm: true });
    expect(refused.status).toBe(502);
    fake.down = false;
    expect((await api('GET', `${P()}/${created.link.id}`)).body.link.stale).toBe(false);
  });
  it('mission CTO bloquée (isolation) : la reprise renvoie BLOCKED tant que le runtime ne fonctionne pas', async () => {
    const created = (await api('POST', P(), newMission())).body;
    fake.missions[0]!.status = 'blocked'; fake.missions[0]!.blockers = ['BLOCKED: bubblewrap_isolation: bwrap not found'];
    fake.preflight = { ok: false, status: 'BLOCKED', blockers: ['bubblewrap_isolation: bwrap not found'], isolation: 'unavailable', checks: [], container_certified: false };
    const refused = await api('POST', `${P()}/${created.link.id}/resume`, { confirm: true });
    expect(refused.status).toBe(409); expect(refused.body.code).toBe('CTO_BLOCKED');
    expect((await api('GET', `${P()}/${created.link.id}`)).body.link.blockers[0]).toContain('BLOCKED');
    fake.preflight = { ok: true, status: 'READY', blockers: [], isolation: 'bubblewrap-namespaces', checks: [], container_certified: false };
    const ok = await api('POST', `${P()}/${created.link.id}/resume`, { confirm: true });
    expect(ok.status).toBe(200); expect(ok.body.link.status).toBe('running');
  });
});

describe('approbations humaines et annulation', () => {
  it('approbation : confirmation obligatoire, seulement si demandée par le CTO, tracée dans l’historique', async () => {
    const { link } = (await api('POST', P(), newMission())).body;
    expect((await api('POST', `${P()}/${link.id}/approvals`, { kind: 'mission', decision: 'approve' })).status).toBe(403);
    const early = await api('POST', `${P()}/${link.id}/approvals`, { kind: 'completion', decision: 'approve', confirm: true });
    expect(early.status).toBe(409); expect(early.body.code).toBe('APPROVAL_NOT_PENDING');
    expect(fake.missions[0]!.status).toBe('pending_approval');
    const approved = await api('POST', `${P()}/${link.id}/approvals`, { kind: 'mission', decision: 'approve', note: 'ok', confirm: true });
    expect(approved.status).toBe(200); expect(approved.body.link.status).toBe('approved');
    expect(fake.events.find((e) => e.type === 'approval_recorded')!.detail.note).toBe('ok [via Open Cortex Code]');
    expect(store.all<any>('history').some((h) => h.kind === 'cto-approval')).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
  it('un jeton CTO en lecture seule ne peut rien approuver ni créer', async () => {
    process.env.CORTEX_CTO_TOKEN = VIEWER;
    expect((await api('GET', '/api/cto/team')).body.supervisor.accessRole).toBe('viewer');
    const denied = await api('POST', P(), newMission());
    expect(denied.status).toBe(403); expect(denied.body.code).toBe('CTO_READ_ONLY');
    expect(fake.missions).toHaveLength(0);
  });
  it('annulation : transmise au CTO, idempotente, et la reprise est ensuite refusée', async () => {
    const { link } = (await api('POST', P(), newMission())).body;
    expect((await api('POST', `${P()}/${link.id}/cancel`, {})).status).toBe(403);
    const cancelled = await api('POST', `${P()}/${link.id}/cancel`, { confirm: true });
    expect(cancelled.body.link.status).toBe('cancelled'); expect(fake.missions[0]!.status).toBe('cancelled');
    expect((await api('POST', `${P()}/${link.id}/cancel`, { confirm: true })).status).toBe(200);
    expect((await api('POST', `${P()}/${link.id}/resume`, { confirm: true })).body.code).toBe('MISSION_CANCELLED');
  });
  it('annulation avant transmission : jamais envoyée au CTO ensuite', async () => {
    fake.rejectNextCreate = true;
    const lost = await api('POST', P(), newMission());
    const cancelled = await api('POST', `${P()}/${lost.body.missionId}/cancel`, { confirm: true });
    expect(cancelled.body.link).toMatchObject({ localState: 'cancelled', status: 'cancelled' });
    expect((await api('POST', `${P()}/${lost.body.missionId}/resume`, { confirm: true })).body.code).toBe('MISSION_CANCELLED');
    expect(fake.missions).toHaveLength(0);
  });
  it('rapport : preuves Git et coûts remontent, sans présenter de push ni de fusion', async () => {
    const { link } = (await api('POST', P(), newMission())).body;
    fake.missions[0]!.git = { branch: 'cto/abcd1234/backend-ef567890', commit: 'a'.repeat(40), base_commit: 'b'.repeat(40), files: ['src/slug.js'], diffstat: ' 1 file changed', pushed: false, merged: false };
    const view = (await api('GET', `${P()}/${link.id}`)).body;
    expect(view.report.git).toMatchObject({ branch: 'cto/abcd1234/backend-ef567890', files: ['src/slug.js'], pushed: false, merged: false });
    expect(view.report.costByRole).toEqual({ architect: 0.05 });
  });
});

// ------------------------------------------------------------------ CTO réel (optionnel)
const CTO_REPO_DIR = process.env.CTO_REPO_DIR;
describe.skipIf(!CTO_REPO_DIR)('contre le vrai CTO IA (CTO_REPO_DIR) : agents scriptés, vrai orchestrateur, vrai dépôt git', () => {
  it('mission → approbations → délégation aux 4 rôles → rapport Git, via le pont', async () => {
    const dir = (file: string) => pathToFileURL(path.join(CTO_REPO_DIR!, file)).href;
    const [{ Cto }, { createServer }, { FileStore }, fixtures] = await Promise.all([import(dir('src/cto.js')), import(dir('src/server.js')), import(dir('src/store/index.js')), import(dir('testkit/fixtures.js'))]);
    const runner = fixtures.scriptedRunner({
      architect: [async () => ({ result: fixtures.PLAN })],
      backend: [async ({ cwd }: { cwd: string }) => { fixtures.write(cwd, 'src/slug.js', fixtures.GOOD_SLUG); fixtures.write(cwd, 'test/slug.test.js', fixtures.SLUG_TEST); return { result: 'ok' }; }],
    });
    const repo = fixtures.makeRepo() as string;
    const realRepo = await realpath(repo);
    const realCto = new Cto({ testRunner: fixtures.trustedFixtureTests, store: new FileStore(fixtures.tmpDir('cto-data-')), runner, repoPath: realRepo, workspacesDir: fixtures.tmpDir('cto-ws-'), limits: { backoffMs: 5 }, preflight: async () => ({ ok: true, status: 'READY', blockers: [], checks: [], isolation: 'bubblewrap-namespaces', container_certified: false }) });
    const server = createServer({ cto: realCto, adminToken: TOKEN });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      process.env.CORTEX_CTO_URL = `http://127.0.0.1:${server.address().port}`;
      store.put('projects', { ...project, path: realRepo });
      const team = (await api('GET', '/api/cto/team')).body;
      expect(team.supervisor.connection).toBe('connected');
      expect(team.agents.map((a: any) => a.role)).toEqual(['architect', 'backend', 'qa', 'security']); // eslint-disable-line @typescript-eslint/no-explicit-any
      const created = (await api('POST', P(), newMission({ scope: ['src', 'test'] }))).body;
      expect(created.link.status).toBe('pending_approval');
      await api('POST', `${P()}/${created.link.id}/approvals`, { kind: 'mission', decision: 'approve', confirm: true });
      await realCto.drain();
      let view = (await api('GET', `${P()}/${created.link.id}`)).body;
      expect(view.link.pendingApprovals).toEqual(['architecture']);
      await api('POST', `${P()}/${created.link.id}/approvals`, { kind: 'architecture', decision: 'approve', confirm: true });
      await realCto.drain();
      view = (await api('GET', `${P()}/${created.link.id}`)).body;
      expect(view.link).toMatchObject({ status: 'review', pendingApprovals: ['completion'] });
      expect(view.report.git.files.sort()).toEqual(['src/slug.js', 'test/slug.test.js']);
      expect(view.report.git).toMatchObject({ pushed: false, merged: false });
      expect(view.tasks.map((t: any) => `${t.role}:${t.status}`)).toEqual(['architect:done', 'backend:done', 'qa:done', 'security:done']); // eslint-disable-line @typescript-eslint/no-explicit-any
      const again = await api('POST', P(), newMission({ idempotencyKey: created.link.id }));
      expect(again.status).toBe(200);
      expect((await realCto.store.list('missions')).length).toBe(1);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 60_000);
});
