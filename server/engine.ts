import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { OpenCode, type OpenCodeClient, type PermissionRule } from '@opencode/client';
import { ENGINE_VERSION, type AgentMode, type Profile, type Project } from '../shared/contracts.js';
import { hashContent, HttpError, isLoopback, safeEnvironment } from './security.js';
import type { Vault } from './vault.js';

export interface EngineOptions { dataDir: string; cliPath?: string; project: (id: string) => Project; profile: (id: string) => Profile; vault: Vault }
interface Worker {
  projectId: string; profileId?: string; mode: AgentMode; fingerprint: string; process: ChildProcess;
  url: string; password: string; client: OpenCodeClient; busy: boolean; diagnostics: string[];
}
const sensitiveResources = ['*.env*', '*credentials*', '*secret*', '*.pem', '*.key', '*.p12', '*.pfx', '*.npmrc', '*.netrc', '*.pypirc', '*id_rsa*', '*id_ed25519*', '*id_ecdsa*', '*/.ssh/*', '*/.aws/*', '*/.azure/*', '*/.gcp/*', '*/.config/*', '*/.opencortex/*', '*/.git/*'];
export function modePermissions(mode: AgentMode): PermissionRule[] {
  const rules: PermissionRule[] = [{ action: '*', resource: '*', effect: mode === 'agent' ? 'ask' : 'deny' }];
  for (const action of ['read', 'glob', 'grep', 'list']) rules.push({ action, resource: '*', effect: 'allow' });
  for (const action of ['external_directory', 'mcp', 'plugin']) rules.push({ action, resource: '*', effect: 'deny' });
  for (const action of ['read', 'edit', 'glob', 'grep']) {
    for (const pattern of sensitiveResources) rules.push({ action, resource: pattern, effect: 'deny' });
  }
  return rules;
}
export function administratorConfig(mode: AgentMode, profile?: Profile): Record<string, unknown> {
  const policies: { action: string; resource: string; effect: 'allow' | 'deny' }[] = [
    ...['plugin.use', 'skill.use', 'websearch.use', 'integration.connect', ...(mode === 'agent' ? [] : ['mcp.use'])].map((action) => ({ action, resource: '*', effect: 'deny' as const })),
    { action: 'tool.use', resource: 'external_directory:*', effect: 'deny' },
    { action: 'tool.use', resource: 'subagent:*', effect: 'deny' },
  ];
  if (mode !== 'agent') {
    policies.push({ action: 'tool.use', resource: '*', effect: 'deny' });
    for (const action of ['read', 'glob', 'grep', 'list']) policies.push({ action: 'tool.use', resource: `${action}:*`, effect: 'allow' });
  }
  for (const action of ['read', 'edit', 'glob', 'grep']) {
    for (const resource of sensitiveResources) policies.push({ action: 'tool.use', resource: `${action}:${resource}`, effect: 'deny' });
  }
  for (const pattern of ['*git push*', '*git merge*', '*git reset*', '*git clean*', '*rm -rf*', '*sudo *', '*printenv*', '* /proc/*']) policies.push({ action: 'tool.use', resource: `shell:${pattern}`, effect: 'deny' });
  // Providers not expressly selected cannot be used by fallback or automatic title/compaction generation.
  if (profile) {
    policies.push({ action: 'provider.use', resource: '*', effect: 'deny' }, { action: 'provider.use', resource: profile.providerId, effect: 'allow' });
  }
  const agents: Record<string, unknown> = {};
  for (const id of ['cortex-ask', 'cortex-plan', 'cortex-agent']) agents[id] = {
    description: 'Agent administré par Open Cortex', mode: 'primary', permissions: modePermissions(mode), steps: 40,
    system: mode === 'agent' ? 'Demander les permissions avant toute mutation ou commande. Ne jamais pousser, fusionner ou effectuer une opération destructive automatiquement.' : 'Lecture seule stricte. Ne pas modifier de fichiers, lancer des commandes, déléguer ou utiliser des intégrations externes.',
  };
  // Prevent built-in agents from circumventing the selected mode.
  for (const id of ['build', 'plan', 'general', 'explore']) agents[id] = { disabled: true };
  const config: Record<string, unknown> = {
    // Native snapshots obey Git ignores, not our sensitive-file policy. Only filtered application checkpoints are enabled.
    update: 'disable', share: 'disabled', warming: false, snapshots: false,
    formatter: false, lsp: false, mcp: {}, skills: [], instructions: [], commands: {}, plugins: [],
    permissions: modePermissions(mode), policies, agents, default_agent: `cortex-${mode}`,
  };
  if (profile) {
    const settings: Record<string, unknown> = { apiKey: '{env:CORTEX_PROVIDER_KEY}', timeout: 120000 };
    if (profile.baseUrl) settings.baseURL = profile.baseUrl;
    const provider: Record<string, unknown> = { name: profile.providerId, env: ['CORTEX_PROVIDER_KEY'], settings };
    // Custom compatible endpoints use the audited built-in SDK adapter, never arbitrary npm plugins.
    if (profile.baseUrl && profile.providerId !== 'ollama') {
      provider.package = '@opencode/ai/providers/openai-compatible';
      provider.models = { [profile.modelId]: { name: profile.modelId, capabilities: { tools: true, input: ['text'], output: ['text'] } } };
    }
    config.providers = { [profile.providerId]: provider };
    config.model = { providerID: profile.providerId, model: profile.modelId };
  }
  return config;
}
async function freePort(): Promise<number> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => { if (address && typeof address !== 'string') resolve(address.port); else reject(new Error('Port unavailable')); }); });
  });
}
async function stop(worker: Worker): Promise<void> {
  if (worker.process.exitCode !== null || worker.process.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const hard = setTimeout(() => worker.process.kill('SIGKILL'), 4000);
    worker.process.once('exit', () => { clearTimeout(hard); resolve(); });
    worker.process.kill('SIGTERM');
  });
}
export function isDangerousPermission(action: string, resources: string[]): boolean {
  if (['external_directory', 'plugin', 'subagent'].includes(action)) return true;
  return action === 'shell' && resources.some((resource) => /(?:\bgit\s+(?:push|merge|reset|clean)\b|\brm\s|\bsudo\b|\b(?:env|printenv)\b|\/proc\/|\b(?:curl|wget)\b.*(?:api[_-]?key|token|secret))/iu.test(resource));
}

export class Engine {
  private readonly workers = new Map<string, Worker>();
  private readonly pending = new Map<string, Promise<Worker>>();
  private readonly cli: string;
  private closed = false;
  constructor(private readonly options: EngineOptions) {
    const require = createRequire(import.meta.url);
    this.cli = options.cliPath || require.resolve('@opencode/cli/bin/opencode.exe');
  }
  async prepare(projectId: string, profileId?: string, mode: AgentMode = 'ask'): Promise<Worker> {
    if (this.closed) throw new HttpError(503, 'Connecteur arrêté.', 'CONNECTOR_CLOSED');
    const project = this.options.project(projectId);
    if (!project.trusted) throw new HttpError(403, 'Exécution non isolée refusée sur projet non approuvé. Un worktree n’est pas une sandbox.', 'UNTRUSTED_PROJECT');
    const profile = profileId ? this.options.profile(profileId) : undefined;
    const secret = profile ? this.options.vault.get(profile.id) : undefined;
    const fingerprint = hashContent(JSON.stringify([mode, profile ? { ...profile, hasSecret: undefined } : null, secret || '']));
    const pending = this.pending.get(projectId);
    if (pending) { await pending; return this.prepare(projectId, profileId, mode); }
    const old = this.workers.get(projectId);
    if (old && old.fingerprint === fingerprint && old.process.exitCode === null && old.process.signalCode === null) return old;
    if (old?.busy) throw new HttpError(409, 'Le projet exécute déjà une session. Interrompre ou attendre avant reconfiguration.', 'PROJECT_BUSY');
    const promise = this.launch(project, profile, mode, fingerprint, old);
    this.pending.set(projectId, promise);
    try { return await promise; } finally { this.pending.delete(projectId); }
  }
  private async launch(project: Project, profile: Profile | undefined, mode: AgentMode, fingerprint: string, old?: Worker): Promise<Worker> {
    if (old) { this.workers.delete(project.id); await stop(old); }
    // CLI does not expose a flag to disable OS-wide admin discovery; refuse an unaudited system config.
    const systemConfig = process.platform === 'darwin' ? '/Library/Application Support/opencode' : process.platform === 'win32' ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'opencode') : '/etc/opencode';
    if (existsSync(systemConfig) && (lstatSync(systemConfig).isSymbolicLink() || readdirSync(systemConfig).length > 0)) throw new HttpError(403, 'Configuration OpenCode système non auditée : démarrage refusé.', 'UNAUDITED_SYSTEM_CONFIG');
    const home = path.join(this.options.dataDir, 'engine', project.id);
    for (const part of ['', 'tmp', 'config', 'data', 'cache', 'state']) {
      const dir = path.join(home, part); mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (realpathSync(dir) !== path.resolve(dir)) throw new HttpError(403, 'Répertoire privé moteur non sûr.', 'PATH_DENIED');
      chmodSync(dir, 0o700);
    }
    const password = randomBytes(32).toString('base64url');
    this.options.vault.set(`engine:${project.id}`, password);
    const env = safeEnvironment(home);
    Object.assign(env, {
      OPENCODE_PASSWORD: password, OPENCODE_CLIENT: 'open-cortex-coder', OPENCODE_CONFIG_DIR: path.join(home, 'config'),
      OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_FREE_MODELS: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify(administratorConfig(mode, profile)),
    });
    if (profile) {
      // No secret is needed for an explicitly configured localhost provider (e.g. Ollama).
      const local = profile.baseUrl && isLoopback(new URL(profile.baseUrl).hostname);
      const key = this.options.vault.get(profile.id);
      if (key) env.CORTEX_PROVIDER_KEY = key;
      else if (local) env.CORTEX_PROVIDER_KEY = 'local-provider-no-credential';
      else env.CORTEX_PROVIDER_KEY = '';
    }
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(this.cli, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: project.path, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const basic = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    this.options.vault.set(`engine-basic:${project.id}`, basic.slice(6));
    const client = OpenCode.make({ baseUrl: url, headers: { Authorization: basic } });
    const worker: Worker = { projectId: project.id, profileId: profile?.id, mode, fingerprint, process: child, url, password, client, busy: false, diagnostics: [] };
    let launchError: Error | undefined;
    child.once('error', (error) => { launchError = error; });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => {
      // Drain pipes, bound and redact diagnostics; never forward raw engine logs to console or renderer.
      worker.diagnostics.push(this.options.vault.redact(chunk.toString()).slice(-4096));
      if (worker.diagnostics.length > 10) worker.diagnostics.shift();
    });
    const deadline = Date.now() + 45000;
    try {
      let ready = false;
      while (Date.now() < deadline) {
        if (launchError || child.exitCode !== null || child.signalCode !== null) throw new HttpError(503, 'Le processus OpenCode n’a pas démarré.', 'ENGINE_START_FAILED');
        try {
          const info = await client.server.info({ signal: AbortSignal.timeout(1500) });
          if (info.version !== ENGINE_VERSION) throw new HttpError(503, `Version moteur incompatible (${info.version}). Version exigée : ${ENGINE_VERSION}.`, 'ENGINE_VERSION_MISMATCH');
          await client.location.get({ location: { directory: project.path } }, { signal: AbortSignal.timeout(15000) });
          ready = true; break;
        } catch (error) { if (error instanceof HttpError) throw error; }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!ready) throw new HttpError(503, 'OpenCode indisponible après délai de démarrage.', 'ENGINE_TIMEOUT');
      this.workers.set(project.id, worker);
      return worker;
    } catch (error) { await stop(worker); throw error; }
  }
  setBusy(projectId: string, busy: boolean): void { const worker = this.workers.get(projectId); if (worker) worker.busy = busy; }
  async activate(projectId: string, profileId: string, mode: AgentMode): Promise<void> { await this.prepare(projectId, profileId, mode); }
  /** Backend-only controlled transport. No credential persistence, raw config, RPC, terminals or REST file writes. */
  async request(projectId: string, method: string, endpoint: string, body?: unknown, profileId?: string): Promise<unknown> {
    method = method.toUpperCase();
    if (!endpoint.startsWith('/api/') || /[\\#]/u.test(endpoint) || endpoint.includes('..') || endpoint.includes('%')) throw new HttpError(403, 'Route moteur refusée.', 'ENGINE_ROUTE_DENIED');
    const pathname = endpoint.split('?')[0];
    const readAllowed = /^\/api\/(?:info|location|model|provider|agent|mcp|skill|vcs(?:\/[^?]*)?|session(?:\/[A-Za-z0-9_-]+(?:\/(?:message|diff|permission|context|inbox))?)?)$/u.test(pathname);
    const sessionWrite = /^\/api\/session(?:\/[A-Za-z0-9_-]+(?:\/(?:agent|model|prompt|interrupt)|\/permission\/[A-Za-z0-9_-]+\/reply)?)?$/u.test(pathname);
    const mcpWrite = (['PUT', 'DELETE'].includes(method) && /^\/api\/experimental\/mcp\/[a-z0-9-]+$/u.test(pathname)) || (method === 'POST' && /^\/api\/experimental\/mcp\/[a-z0-9-]+\/(?:connect|disconnect)$/u.test(pathname));
    if (!(method === 'GET' && readAllowed) && !(['POST', 'PATCH'].includes(method) && sessionWrite) && !mcpWrite) throw new HttpError(403, 'Route moteur non autorisée par le connecteur.', 'ENGINE_ROUTE_DENIED');
    if (/\/permission\/[^/]+\/reply$/u.test(pathname)) {
      const decision = body && typeof body === 'object' && 'decision' in body ? body.decision : undefined;
      if (!['once', 'reject'].includes(String(decision))) throw new HttpError(403, 'Permission persistante always refusée.', 'ALWAYS_DENIED');
    }
    const current = this.workers.get(projectId);
    const worker = await this.prepare(projectId, profileId ?? current?.profileId, current?.mode ?? 'ask');
    const url = new URL(endpoint, worker.url);
    // Never accept caller-provided location query overrides.
    for (const key of [...url.searchParams.keys()]) if (key.startsWith('location') || key === 'directory') url.searchParams.delete(key);
    if ((method === 'GET' && !pathname.startsWith('/api/session/') && pathname !== '/api/info') || mcpWrite) url.searchParams.set('location[directory]', this.options.project(projectId).path);
    if (mcpWrite && /\/connect$/u.test(pathname) && worker.mode !== 'agent') throw new HttpError(403, 'Connexion MCP refusée dans Ask/Plan. Préparer explicitement une session Agent puis reconnecter.', 'MCP_MODE_DENIED');
    let payload = body;
    if (method === 'POST' && pathname === '/api/session') payload = { ...(body && typeof body === 'object' ? body : {}), location: { directory: this.options.project(projectId).path } };
    let response: Response;
    try {
      response = await fetch(url, { method, headers: { Authorization: `Basic ${Buffer.from(`opencode:${worker.password}`).toString('base64')}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(30000), redirect: 'error' });
    } catch { throw new HttpError(503, 'Connexion moteur interrompue ou expirée.', 'ENGINE_CONNECTION_FAILED'); }
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (text.length > 8 * 1024 * 1024) throw new HttpError(502, 'Réponse moteur trop volumineuse.', 'ENGINE_RESPONSE_TOO_LARGE');
    if (!response.ok) throw new HttpError(response.status >= 500 ? 502 : response.status, this.options.vault.redact(text).slice(0, 1500) || 'Requête moteur refusée.', 'ENGINE_REQUEST_FAILED');
    try { return JSON.parse(text) as unknown; } catch { throw new HttpError(502, 'Réponse moteur non JSON.', 'ENGINE_PROTOCOL_ERROR'); }
  }
  async invalidateProfile(profileId: string): Promise<void> {
    await Promise.allSettled([...this.pending.values()]);
    for (const [id, worker] of this.workers) if (worker.profileId === profileId) { this.workers.delete(id); await stop(worker); }
  }
  async invalidateProject(projectId: string): Promise<void> {
    const pending = this.pending.get(projectId);
    if (pending) await pending.catch(() => undefined);
    const worker = this.workers.get(projectId);
    if (worker) { this.workers.delete(projectId); await stop(worker); }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all([...this.workers.values()].map(stop));
    this.workers.clear();
  }
}
