import express, { type ErrorRequestHandler, type Express, type Request, type Response } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { ENGINE_VERSION, type Bootstrap, type CortexSession, type MemoryEntry, type PermissionRequest, type Profile, type Project } from '../shared/contracts.js';
import { CoreContext, type ConnectorContext, promptSchema, sessionSchema } from './context.js';
import { isDangerousPermission } from './engine.js';
import { HttpError, isLoopback, MAX_FILE_BYTES, networkGuard, validateBaseUrl } from './security.js';
import { listFileCheckpoints, listFiles, readFile, restoreFileCheckpoint, writeFile } from './core-files.js';
import { PairingManager } from './pairing.js';

export interface ConnectorOptions {
  port?: number; host?: string; dataDir?: string; staticDir?: string; cliPath?: string;
  quiet?: boolean; logPairing?: boolean;
  /** Explicit local developer origins only. Not a cloud proxy. Same-origin is the secure default. */
  allowedOrigins?: string[];
}
export interface ConnectorHandle { port: number; token: string; close: () => Promise<void>; context: ConnectorContext }
const label = z.string().trim().min(1).max(200);
const id = (req: Request, name = 'id'): string => {
  const value = req.params[name];
  if (typeof value !== 'string' || !value || value.length > 200) throw new HttpError(400, 'Identifiant invalide.', 'INVALID_ID');
  return value;
};
const queryPath = (req: Request): string => {
  const value = req.query.path;
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new HttpError(400, 'Chemin unique requis.', 'INVALID_PATH');
  return value;
};
const profileSchema = z.object({ name: label, providerId: z.string().regex(/^[a-zA-Z0-9_-]+$/u).max(100), modelId: z.string().min(1).max(200).refine((value) => !/[\0\r\n]/u.test(value)), baseUrl: z.string().max(2048).optional(), apiKey: z.string().max(16384).optional() }).strict();
const memorySchema = z.object({ kind: z.enum(['decision', 'instruction', 'task', 'error', 'note']), title: label, content: z.string().min(1).max(100000) }).strict();
function unwrap<T>(result: unknown): T { return result && typeof result === 'object' && 'data' in result ? result.data as T : result as T; }

function registerCoreRoutes(app: Express, ctx: CoreContext, advancedAvailable: () => boolean, pairings: PairingManager): void {
  app.get('/api/pair/control', (_req, res) => res.json(pairings.control()));
  app.post('/api/pair/control', (req, res) => {
    const input = z.object({ enabled: z.boolean(), confirm: z.literal(true) }).strict().parse(req.body);
    if (input.enabled) pairings.enableFor(); else pairings.disable();
    res.json(pairings.control());
  });
  app.post('/api/pair/requests', (req, res) => {
    if (!req.is('application/json')) throw new HttpError(415, 'Le pairing exige une requête JSON explicite.', 'PAIRING_CONTENT_TYPE_REQUIRED');
    z.object({}).strict().parse(req.body);
    const origin = req.headers.origin;
    if (!origin) throw new HttpError(403, 'Origin HTTPS absente.', 'PAIRING_ORIGIN_REQUIRED');
    res.status(202).json(pairings.request(origin));
  });
  app.get('/api/pair/requests', (_req, res) => res.json(pairings.list()));
  app.post('/api/pair/requests/:id/approve', (req, res) => {
    z.object({ confirm: z.literal(true) }).strict().parse(req.body);
    res.json(pairings.approve(id(req)));
  });
  app.post('/api/pair/requests/:id/deny', (req, res) => {
    z.object({ confirm: z.literal(true) }).strict().parse(req.body);
    pairings.deny(id(req)); res.json({ state: 'denied' });
  });
  app.get('/api/pair/requests/:id', (req, res) => {
    const origin = req.headers.origin;
    if (!origin) throw new HttpError(403, 'Origin HTTPS absente.', 'PAIRING_ORIGIN_REQUIRED');
    res.json(pairings.status(id(req), origin));
  });
  app.get('/api/pair/sessions', (_req, res) => res.json(pairings.list().filter((pairing) => pairing.state === 'approved' || pairing.state === 'paired')));
  app.delete('/api/pair/sessions/:id', (req, res) => {
    z.object({ confirm: z.literal(true) }).strict().parse(req.body);
    pairings.revoke(id(req)); res.json({ state: 'revoked' });
  });
  app.get('/api/health', (_req, res) => res.json({ healthy: true, version: '0.1.0', engineVersion: ENGINE_VERSION, localOnly: true }));
  app.get('/api/bootstrap', (_req, res) => {
    const body: Bootstrap = { projects: ctx.store.all<Project>('projects'), profiles: ctx.store.all<Profile>('profiles').map((profile) => ctx.profile(profile.id)), version: '0.1.0', engineVersion: ENGINE_VERSION, capabilities: { localConnector: true, files: true, engine: true, memory: true, byokMemory: true, sandbox: false, osVault: false, advanced: advancedAvailable() } };
    res.json(body);
  });
  app.get('/api/projects', (_req, res) => res.json(ctx.store.all<Project>('projects')));
  app.post('/api/projects', async (req, res) => {
    const input = z.object({ name: label, path: z.string().min(1).max(4096), trusted: z.boolean() }).strict().parse(req.body);
    let root: string;
    try { root = realpathSync(input.path); if (!statSync(root).isDirectory()) throw new Error('not directory'); }
    catch { throw new HttpError(400, 'Un répertoire local existant est requis.', 'INVALID_PROJECT_PATH'); }
    if (path.parse(root).root === root || root === path.resolve(os.homedir()) || root === path.resolve(ctx.store.filename, '..')) throw new HttpError(403, 'Ouvrir un dossier de projet dédié, pas une racine système/personnelle ou le stockage du connecteur.', 'PROJECT_ROOT_DENIED');
    const existing = ctx.store.all<Project>('projects').find((project) => project.path === root);
    if (existing) {
      // A new explicit trusted value is consent; no inherited/implicit trust from repository contents.
      const updated = ctx.store.put('projects', { ...existing, name: input.name, trusted: input.trusted, updatedAt: new Date().toISOString() });
      if (!input.trusted) {
        await ctx.engine.invalidateProject(existing.id);
        for (const session of ctx.store.all<CortexSession>('sessions', existing.id)) if (session.status === 'running' || session.status === 'permission') ctx.store.put('sessions', { ...session, status: 'error', updatedAt: new Date().toISOString() }, existing.id);
      }
      ctx.history(updated.id, 'project-trust', 'Confiance explicitement mise à jour', input.trusted ? 'Projet approuvé par l’utilisateur.' : 'Confiance retirée.');
      res.json(updated); return;
    }
    const now = new Date().toISOString();
    const project = ctx.store.put('projects', { id: randomUUID(), name: input.name, path: root, trusted: input.trusted, createdAt: now, updatedAt: now });
    ctx.history(project.id, 'project-open', 'Projet ouvert', input.trusted ? 'Exécution locale explicitement approuvée.' : 'Projet non approuvé : exécution moteur et commandes refusées.');
    res.status(201).json(project);
  });
  app.get('/api/projects/:id/files', (req, res) => res.json(listFiles(ctx.project(id(req)), queryPath(req))));
  app.get('/api/projects/:id/file', (req, res) => res.json(readFile(ctx.project(id(req)), queryPath(req))));
  app.put('/api/projects/:id/file', (req, res) => {
    const input = z.object({ path: z.string().min(1).max(4096), content: z.string().max(MAX_FILE_BYTES), hash: z.string().regex(/^[a-f0-9]{64}$/u), confirm: z.literal(true) }).strict().parse(req.body);
    res.json(writeFile(ctx, ctx.project(id(req)), input));
  });
  app.get('/api/projects/:id/file-checkpoints', (req, res) => {
    const project = ctx.project(id(req));
    res.json(listFileCheckpoints(ctx, project, queryPath(req)));
  });
  app.post('/api/projects/:id/file-checkpoints/:checkpointId/restore', (req, res) => {
    const project = ctx.project(id(req));
    const input = z.object({ path: z.string().min(1).max(4096), expectedHash: z.string().regex(/^[a-f0-9]{64}$/u), confirm: z.literal(true) }).strict().parse(req.body);
    res.json(restoreFileCheckpoint(ctx, project, { ...input, id: id(req, 'checkpointId'), confirm: true }));
  });
  app.get('/api/profiles', (_req, res) => res.json(ctx.store.all<Profile>('profiles').map((profile) => ctx.profile(profile.id))));
  app.post('/api/profiles', (req, res) => {
    const input = profileSchema.parse(req.body);
    const profile: Profile = { id: randomUUID(), name: input.name, providerId: input.providerId, modelId: input.modelId, ...(input.baseUrl ? { baseUrl: validateBaseUrl(input.baseUrl) } : {}), hasSecret: false, createdAt: new Date().toISOString() };
    if (input.apiKey) ctx.vault.set(profile.id, input.apiKey);
    ctx.store.put('profiles', profile); res.status(201).json(ctx.profile(profile.id));
  });
  app.put('/api/profiles/:id/secret', async (req, res) => {
    const profile = ctx.profile(id(req));
    const input = z.object({ apiKey: z.string().min(1).max(16384) }).strict().parse(req.body);
    ctx.vault.set(profile.id, input.apiKey);
    await ctx.engine.invalidateProfile(profile.id);
    res.json({ hasSecret: true });
  });
  app.delete('/api/profiles/:id/secret', async (req, res) => {
    const profile = ctx.profile(id(req));
    ctx.vault.delete(profile.id); await ctx.engine.invalidateProfile(profile.id);
    res.json({ hasSecret: false });
  });
  app.post('/api/profiles/:id/test', async (req, res) => {
    const profile = ctx.profile(id(req));
    if (!profile.baseUrl) throw new HttpError(501, 'Test fournisseur non génératif disponible pour les endpoints API compatibles configurés avec baseUrl seulement. Les métadonnées moteur ne valident pas une clé.', 'PROVIDER_TEST_UNSUPPORTED');
    const local = isLoopback(new URL(profile.baseUrl).hostname);
    const key = ctx.vault.get(profile.id);
    if (!key && !local) throw new HttpError(409, 'Clé absente en mémoire. Aucun test externe lancé.', 'PROFILE_SECRET_REQUIRED');
    const endpoint = `${validateBaseUrl(profile.baseUrl)}/models`;
    let response: globalThis.Response;
    try { response = await fetch(endpoint, { headers: key ? { Authorization: `Bearer ${key}` } : {}, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw new HttpError(502, 'Endpoint fournisseur inaccessible ou délai dépassé.', 'PROVIDER_TEST_FAILED'); }
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, `Le fournisseur a répondu HTTP ${response.status}; aucune génération réalisée.`, 'PROVIDER_TEST_FAILED'); }
    const contentType = response.headers.get('content-type');
    if (!contentType?.includes('application/json')) { await response.body?.cancel(); throw new HttpError(502, 'Réponse fournisseur non JSON.', 'PROVIDER_TEST_FAILED'); }
    await response.body?.cancel();
    res.json({ ok: true, detail: `GET /models réel : HTTP ${response.status}. Cela vérifie l’endpoint${key ? ' et son authentification acceptée' : ' local sans clé'}, pas l’accès effectif au modèle ${profile.modelId}, ses quotas ni une génération.` });
  });
  app.get('/api/projects/:id/models', async (req, res) => res.json(await ctx.catalog(id(req))));
  app.get('/api/projects/:id/sessions', (req, res) => { ctx.project(id(req)); res.json(ctx.store.all<CortexSession>('sessions', id(req))); });
  app.post('/api/projects/:id/sessions', async (req, res) => res.status(201).json(await ctx.createSession(id(req), sessionSchema.parse(req.body))));
  app.get('/api/sessions/:id', async (req, res) => res.json(await ctx.refreshSession(id(req))));
  app.get('/api/sessions/:id/messages', async (req, res) => res.json(await ctx.messages(id(req))));
  app.post('/api/sessions/:id/prompt', async (req, res) => res.status(202).json(await ctx.prompt(id(req), promptSchema.parse(req.body))));
  app.post('/api/sessions/:id/interrupt', async (req, res) => {
    const session = ctx.session(id(req));
    if (!session.engineId) throw new HttpError(409, 'Session moteur absente.', 'ENGINE_SESSION_REQUIRED');
    await ctx.engine.request(session.projectId, 'POST', `/api/session/${session.engineId}/interrupt`, {}, session.profileId);
    ctx.engine.setBusy(session.projectId, false);
    ctx.store.put('sessions', { ...session, status: 'idle', updatedAt: new Date().toISOString() }, session.projectId);
    ctx.history(session.projectId, 'interrupt', 'Interruption demandée au moteur', session.id);
    res.json({ ok: true });
  });
  app.get('/api/sessions/:id/permissions', async (req, res) => {
    const session = ctx.session(id(req));
    if (!session.engineId) { res.json([]); return; }
    const requests = unwrap<{ id: string; action: string; resources: string[]; message?: string }[]>(await ctx.engine.request(session.projectId, 'GET', `/api/session/${session.engineId}/permission`, undefined, session.profileId));
    const normalized: PermissionRequest[] = requests.map((request) => ({ id: request.id, sessionId: session.id, action: request.action, resources: request.resources, description: request.message }));
    res.json(normalized);
  });
  app.post('/api/sessions/:id/permissions/:requestId', async (req, res) => {
    const input = z.object({ decision: z.enum(['once', 'reject']) }).strict().parse(req.body);
    const session = ctx.session(id(req));
    if (!session.engineId) throw new HttpError(409, 'Session moteur absente.', 'ENGINE_SESSION_REQUIRED');
    const requests = unwrap<{ id: string; action: string; resources: string[] }[]>(await ctx.engine.request(session.projectId, 'GET', `/api/session/${session.engineId}/permission`, undefined, session.profileId));
    const request = requests.find((item) => item.id === id(req, 'requestId'));
    if (!request) throw new HttpError(404, 'Permission absente de cette session.', 'PERMISSION_NOT_FOUND');
    if (input.decision === 'once' && (session.mode !== 'agent' || isDangerousPermission(request.action, request.resources))) throw new HttpError(403, 'Action bloquée par la politique administrateur. Aucune approbation envoyée.', 'PERMISSION_POLICY_DENIED');
    await ctx.engine.request(session.projectId, 'POST', `/api/session/${session.engineId}/permission/${request.id}/reply`, input, session.profileId);
    ctx.history(session.projectId, 'permission', `Permission ${input.decision}`, `${request.action}; ${request.resources.join(', ')}`);
    res.json({ ok: true });
  });
  app.get('/api/projects/:id/memory', (req, res) => { ctx.project(id(req)); res.json(ctx.store.all<MemoryEntry>('memory', id(req))); });
  app.post('/api/projects/:id/memory', (req, res) => {
    const project = ctx.project(id(req)); const input = memorySchema.parse(req.body);
    const entry: MemoryEntry = { ...input, id: randomUUID(), projectId: project.id, updatedAt: new Date().toISOString() };
    res.status(201).json(ctx.store.put('memory', entry, project.id));
  });
  app.put('/api/projects/:id/memory/:entryId', (req, res) => {
    const project = ctx.project(id(req)); const input = memorySchema.parse(req.body);
    const entry = ctx.store.get<MemoryEntry>('memory', id(req, 'entryId'));
    if (!entry || entry.projectId !== project.id) throw new HttpError(404, 'Mémoire absente de ce projet.', 'MEMORY_NOT_FOUND');
    res.json(ctx.store.put('memory', { ...entry, ...input, updatedAt: new Date().toISOString() }, project.id));
  });
}

export async function startConnector(options: ConnectorOptions = {}): Promise<ConnectorHandle> {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopback(host)) throw new HttpError(400, 'Le connecteur accepte exclusivement loopback.', 'NONLOCAL_BIND_DENIED');
  if (options.allowedOrigins?.some((origin) => { try { const url = new URL(origin); return url.protocol !== 'http:' || !isLoopback(url.hostname) || url.origin !== origin; } catch { return true; } })) throw new HttpError(400, 'Origins autorisées exclusivement locales et explicites.', 'NONLOCAL_ORIGIN_DENIED');
  const requestedPort = options.port ?? 4000;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new HttpError(400, 'Port invalide.', 'INVALID_PORT');
  const dataDir = path.resolve(options.dataDir ?? path.join(os.homedir(), '.opencortex'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (realpathSync(dataDir) !== dataDir) throw new HttpError(403, 'Stockage privé via symlink refusé.', 'PATH_DENIED');
  const context = new CoreContext({ dataDir, cliPath: options.cliPath });
  const pairings = new PairingManager();
  const app = express(); app.disable('x-powered-by'); app.set('trust proxy', false);
  const token = randomBytes(32).toString('base64url'); context.vault.set('connector-token', token);
  let port = requestedPort;
  app.use(networkGuard({
    token,
    port: () => port,
    host,
    allowedOrigins: options.allowedOrigins,
    canUseRemoteOrigin: (origin) => pairings.hasOrigin(origin),
    authenticateRemote: (remoteToken, origin) => pairings.authenticate(remoteToken, origin),
    canRevokeRemotePairing: (remoteToken, origin, pairingId) => pairings.canRevoke(remoteToken, origin, pairingId),
    allowPairingRoute: (origin, routePath, method) => {
      if (routePath === '/api/pair/requests' && method === 'POST') return pairings.acceptsOrigin(origin);
      const match = routePath.match(/^\/api\/pair\/requests\/([0-9a-f-]{36})$/iu);
      return method === 'GET' && Boolean(match && pairings.canReadRequest(match[1]!, origin));
    },
  }));
  app.use(express.json({ limit: MAX_FILE_BYTES + 128000, strict: true }));
  app.use((_req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body: unknown) => json(context.vault.redactValue(body));
    next();
  });
  let advancedAvailable = false;
  registerCoreRoutes(app, context, () => advancedAvailable, pairings);
  try {
    // Deferred import permits parallel construction; an existing module's own import failure is not hidden.
    const modulePath = './routes-advanced.js';
    const advanced = await import(modulePath) as { registerAdvancedRoutes: (app: Express, context: ConnectorContext) => void };
    advanced.registerAdvancedRoutes(app, context); advancedAvailable = true;
  } catch (error) {
    const advancedSource = path.join(path.dirname(fileURLToPath(import.meta.url)), 'routes-advanced.ts');
    const advancedBuilt = path.join(path.dirname(fileURLToPath(import.meta.url)), 'routes-advanced.js');
    if (existsSync(advancedSource) || existsSync(advancedBuilt)) { await context.close(); throw error; }
  }
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Route API inconnue.', 'NOT_FOUND')));
  const staticDir = path.resolve(options.staticDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist')) ? '../dist' : '../../dist'));
  if (existsSync(path.join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir, { dotfiles: 'deny', index: false, etag: false, redirect: false, setHeaders: (res) => res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-src http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'self'; frame-ancestors 'none'") }));
    app.get('/{*path}', (_req, res) => { res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-src http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"); res.sendFile(path.join(staticDir, 'index.html')); });
  } else app.get('/', (_req, res) => res.type('text').send('Open Cortex : frontend local non compilé. Exécuter pnpm build:web. API disponible avec pairing Bearer.'));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) return;
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'Paramètres invalides ou confirmation absente.', code: 'VALIDATION_ERROR' }); return; }
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    const e = error as { status?: number; type?: string };
    if (e?.type === 'entity.too.large') { res.status(413).json({ error: 'Corps trop volumineux.', code: 'BODY_TOO_LARGE' }); return; }
    if (e?.status === 400) { res.status(400).json({ error: 'JSON invalide.', code: 'INVALID_JSON' }); return; }
    res.status(500).json({ error: 'Erreur locale. L’opération n’a pas été déclarée réussie.', code: 'INTERNAL_ERROR' });
  };
  app.use(errors);
  const server = await new Promise<import('node:http').Server>((resolve, reject) => {
    const listener = app.listen(requestedPort, host === 'localhost' ? '127.0.0.1' : host, () => resolve(listener));
    listener.once('error', reject);
  }).catch(async (error: unknown) => { await context.close(); throw error; });
  const address = server.address(); if (!address || typeof address === 'string') { await context.close(); throw new Error('Connector failed to bind'); }
  port = address.port;
  if (!options.quiet && options.logPairing !== false) console.log(`Open Cortex local : http://${host === '::1' ? '[::1]' : host}:${port}/#token=${token}`);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    const shutdown: unknown = app.locals.shutdownAdvanced;
    if (typeof shutdown === 'function') await shutdown();
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeIdleConnections(); });
    await context.close();
  })();
  return { port, token, close, context };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  startConnector({ port: Number(process.env.CORTEX_PORT ?? 4000), host: process.env.CORTEX_HOST ?? '127.0.0.1', dataDir: process.env.CORTEX_DATA_DIR, staticDir: process.env.CORTEX_STATIC_DIR }).then((connector) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void connector.close().then(() => { process.exitCode = 0; }); });
  }).catch(() => { console.error('Démarrage du connecteur local refusé ou échoué. Vérifier le port, les chemins privés et la version Node/OpenCode.'); process.exitCode = 1; });
}
