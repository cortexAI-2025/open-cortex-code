import type { Express } from 'express';
import type { Project } from '../../shared/contracts.js';
import { z } from 'zod';
import { AdvancedError, type Context, all, confirmed, data, id, now, param, project, redact, route, slug, trusted, withProjectLock } from './common.js';
import { validateHeaders, validateUrl, resolveTarget } from './network.js';
import { safeEnvironment } from './process.js';

export interface McpConfig { id: string; projectId: string; name: string; type: 'local' | 'remote'; command?: string[]; url?: string; headers: Record<string, string>; hasSecret: boolean; createdAt: string }
interface McpStatus { name: string; status: { status: string; error?: string }; title?: string }
interface McpSecrets { headers?: Record<string, string>; environment?: Record<string, string> }
const key = (p: string, name: string) => `advanced:mcp:${p}:${name}`;
const mcpBody = z.object({ name: slug, type: z.enum(['local', 'remote']), command: z.array(z.string().min(1).max(4096).refine((s) => !s.includes('\0'))).min(1).max(32).optional(), url: z.string().max(2048).optional(), headers: z.record(z.string(), z.string()).optional(), secretHeaders: z.record(z.string(), z.string()).optional(), secretEnvironment: z.record(z.string(), z.string()).optional(), confirm: z.literal(true) }).strict();
function validateEnvironment(input: Record<string, string> = {}): Record<string, string> {
  if (Object.keys(input).length > 32) throw new AdvancedError(400, 'INVALID_MCP_ENV', 'Maximum 32 variables MCP.');
  for (const [name, value] of Object.entries(input)) if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name) || /^(?:PATH|HOME|NODE_OPTIONS|LD_|DYLD_|BASH_ENV|ENV|OPENCODE|CORTEX|ELECTRON|BUN|PYTHONPATH|PYTHONHOME|PERL5OPT|RUBYOPT|GIT_CONFIG|SHELLOPTS|SSH_AUTH_SOCK)/.test(name) || /[\r\n\0]/.test(value) || !value.trim() || value.length > 4096)
    throw new AdvancedError(400, 'INVALID_MCP_ENV', 'Variable MCP sensible non autorisée.');
  return input;
}
function clearSecrets(ctx: Context, p: string, name: string): void {
  const raw = ctx.vault.get(key(p, name));
  if (raw) {
    const secrets = JSON.parse(raw) as McpSecrets;
    for (const [type, entries] of Object.entries(secrets)) for (const field of Object.keys(entries ?? {})) ctx.vault.delete(`${key(p, name)}:${type}:${field}`);
  }
  ctx.vault.delete(key(p, name));
}
function setSecrets(ctx: Context, p: string, name: string, secrets: McpSecrets): boolean {
  const raw = JSON.stringify(secrets);
  if (raw.length > 16_000) throw new AdvancedError(400, 'MCP_SECRET_LIMIT', 'Secrets MCP limités à 16 Ko.');
  const hasSecret = Object.values(secrets).some((v) => Object.keys(v ?? {}).length > 0);
  clearSecrets(ctx, p, name);
  if (hasSecret) {
    // Register each value separately so server errors containing one token are redacted too.
    for (const [type, entries] of Object.entries(secrets)) for (const [field, value] of Object.entries((entries ?? {}) as Record<string, string>)) ctx.vault.set(`${key(p, name)}:${type}:${field}`, value);
    ctx.vault.set(key(p, name), raw);
  }
  return hasSecret;
}
function findConfig(ctx: Context, p: Project, name: string): McpConfig {
  const config = all<McpConfig>(ctx, 'mcp', p.id).find((c) => c.name === name);
  if (!config) throw new AdvancedError(404, 'NOT_FOUND', 'Connexion MCP introuvable dans ce projet.');
  return config;
}
export function localMcpCommand(command: string[], environment: Record<string, string>): string[] {
  // Node wrapper receives secrets through env only, never argv; clears inherited engine/provider credentials.
  const names = Object.keys(environment);
  const script = `const{spawn}=require('node:child_process');const env=${JSON.stringify(safeEnvironment())};for(const k of ${JSON.stringify(names)})if(process.env[k]!==undefined)env[k]=process.env[k];const args=process.argv.slice(1);if(process.versions.electron&&args[0]===process.execPath)env.ELECTRON_RUN_AS_NODE='1';const p=spawn(args[0],args.slice(1),{env,stdio:'inherit'});p.on('error',()=>process.exit(127));p.on('exit',(c,s)=>process.exit(c===null?1:c));for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>p.kill(s));`;
  return [process.execPath, '-e', script, '--', ...command];
}
export function runtimeMcpConfig(ctx: Context, p: Project, config: McpConfig): Record<string, unknown> {
  if (config.projectId !== p.id) throw new AdvancedError(404, 'NOT_FOUND', 'MCP hors projet.');
  const raw = ctx.vault.get(key(p.id, config.name));
  if (config.hasSecret && !raw) throw new AdvancedError(503, 'MCP_SECRET_REQUIRED', 'Secrets MCP absents après redémarrage; les réintroduire.');
  const secrets = raw ? JSON.parse(raw) as McpSecrets : {};
  if (config.type === 'local') {
    const environment = validateEnvironment(secrets.environment);
    const wrapperEnvironment = { ...environment, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
    return { type: 'local', command: localMcpCommand(config.command!, environment), cwd: p.path, environment: wrapperEnvironment, disabled: true, pool: false, timeout: { startup: 10_000, catalog: 10_000, execution: 30_000 } };
  }
  return { type: 'remote', url: config.url, headers: { ...validateHeaders(config.headers), ...validateHeaders(secrets.headers, true) }, oauth: false, disabled: true, pool: false, timeout: { startup: 10_000, catalog: 10_000, execution: 30_000 } };
}
export async function mcpStatuses(ctx: Context, p: Project): Promise<McpStatus[]> {
  trusted(p);
  const response = data<unknown>(await ctx.engine.request(p.id, 'GET', '/api/mcp'));
  if (!Array.isArray(response) || response.some((s) => !s || typeof s.name !== 'string' || typeof s.status?.status !== 'string')) throw new AdvancedError(502, 'MCP_PROTOCOL_ERROR', 'Statut MCP V2 inattendu.');
  return (response as McpStatus[]).map((s) => ({ name: s.name, status: { status: s.status.status, ...(s.status.error ? { error: redact(ctx, s.status.error) } : {}) }, ...(s.title ? {title: redact(ctx, s.title)} : {}) }));
}
export async function connectMcp(ctx: Context, p: Project, config: McpConfig): Promise<unknown> {
  trusted(p);
  if (config.projectId !== p.id) throw new AdvancedError(404, 'NOT_FOUND', 'Connexion MCP introuvable dans ce projet.');
  if (config.type === 'remote') await resolveTarget(validateUrl(config.url!), false);
  const endpoint = `/api/experimental/mcp/${slug.parse(config.name)}`;
  await ctx.engine.request(p.id, 'PUT', endpoint, { config: runtimeMcpConfig(ctx, p, config) });
  await ctx.engine.request(p.id, 'POST', `${endpoint}/connect`);
  const status = (await mcpStatuses(ctx, p)).find((s) => s.name === config.name);
  if (!status) throw new AdvancedError(502, 'MCP_PROTOCOL_ERROR', 'Aucun statut moteur pour cette connexion.');
  ctx.history(p.id, 'mcp-connect', 'Connexion MCP testée', `${config.name}: ${status.status.status}`);
  if (status.status.status !== 'connected') throw new AdvancedError(503, 'MCP_NOT_CONNECTED', status.status.error ?? `MCP : ${status.status.status}`, { mcpStatus: status.status.status });
  return { ...config, hasSecret: Boolean(ctx.vault.get(key(p.id, config.name))), ...status };
}
export function registerMcpRoutes(app: Express, ctx: Context): void {
  const root = '/api/projects/:id/mcp';
  app.get(root, route(ctx, async (req, res) => {
    const p = project(ctx, req), statuses = await mcpStatuses(ctx, p), configs = all<McpConfig>(ctx, 'mcp', p.id);
    const managed: unknown[] = configs.map((c) => ({ ...c, managed: true, hasSecret: Boolean(ctx.vault.get(key(p.id, c.name))), status: statuses.find((s) => s.name === c.name)?.status ?? null }));
    res.json(managed.concat(statuses.filter((s) => !configs.some((c) => c.name === s.name)).map((s) => ({ ...s, managed: false, source: 'engine' }))));
  }));
  app.post(root, route(ctx, async (req, res) => {
    const p = project(ctx, req); confirmed(req.body); trusted(p); const b = mcpBody.parse(req.body);
    const result = await withProjectLock(p.id, async () => {
      if (all<McpConfig>(ctx, 'mcp', p.id).some((c) => c.name === b.name)) throw new AdvancedError(409, 'MCP_EXISTS', 'Nom MCP déjà utilisé.');
      const headers = validateHeaders(b.headers);
      if (Object.values(headers).some((v) => redact(ctx, v) !== v)) throw new AdvancedError(400, 'MCP_SECRET_IN_CONFIG', 'Secret interdit dans les headers publics.');
      let secrets: McpSecrets;
      if (b.type === 'remote') {
        if (!b.url || b.command || b.secretEnvironment) throw new AdvancedError(400, 'INVALID_MCP', 'Remote exige URL HTTPS, sans commande/environnement.');
        await resolveTarget(validateUrl(b.url), false); secrets = { headers: validateHeaders(b.secretHeaders, true) };
      } else {
        if (!b.command || b.url || b.headers || b.secretHeaders) throw new AdvancedError(400, 'INVALID_MCP', 'Local exige commande, sans URL/headers.');
        if (b.command.some((arg) => redact(ctx, arg) !== arg)) throw new AdvancedError(400, 'MCP_SECRET_IN_ARGV', 'Secret interdit dans argv; utiliser secretEnvironment.');
        secrets = { environment: validateEnvironment(b.secretEnvironment) };
      }
      const hasSecret = setSecrets(ctx, p.id, b.name, secrets);
      const config: McpConfig = { id: id(), projectId: p.id, name: b.name, type: b.type, ...(b.command ? {command: b.command} : {}), ...(b.url ? {url: b.url} : {}), headers, hasSecret, createdAt: now() };
      const endpoint = `/api/experimental/mcp/${b.name}`;
      try { await ctx.engine.request(p.id, 'PUT', endpoint, { config: runtimeMcpConfig(ctx, p, config) }); ctx.store.put('mcp', config, p.id); }
      catch (e) { await ctx.engine.request(p.id, 'DELETE', endpoint).catch(() => {}); clearSecrets(ctx, p.id, b.name); throw e; }
      ctx.history(p.id, 'mcp', 'MCP enregistré désactivé (non connecté)', b.name);
      const status = (await mcpStatuses(ctx, p)).find((s) => s.name === b.name)?.status ?? null;
      return { ...config, status };
    });
    res.status(201).json(result);
  }));
  app.put(`${root}/:name/secret`, route(ctx, async (req, res) => {
    const p = project(ctx, req); confirmed(req.body); trusted(p); const name = slug.parse(param(req, 'name'));
    const b = z.object({secretHeaders: z.record(z.string(), z.string()).optional(), secretEnvironment: z.record(z.string(), z.string()).optional(), confirm: z.literal(true)}).strict().parse(req.body);
    await withProjectLock(p.id, async () => {
      const config = findConfig(ctx, p, name);
      if (config.type === 'local' && b.secretHeaders || config.type === 'remote' && b.secretEnvironment) throw new AdvancedError(400, 'INVALID_MCP', 'Type de secret incompatible.');
      const secrets: McpSecrets = config.type === 'local' ? {environment: validateEnvironment(b.secretEnvironment)} : {headers: validateHeaders(b.secretHeaders, true)};
      await ctx.engine.request(p.id, 'POST', `/api/experimental/mcp/${name}/disconnect`).catch((e: unknown) => { if (!(e && typeof e === 'object' && 'status' in e && e.status === 404)) throw e; });
      const hasSecret = setSecrets(ctx, p.id, name, secrets); ctx.store.put('mcp', {...config, hasSecret}, p.id); ctx.history(p.id, 'mcp-secret', 'Secrets MCP remplacés; reconnecter explicitement', name);
    });
    res.json({hasSecret: Boolean(ctx.vault.get(key(p.id, name))), reconnectRequired: true});
  }));
  app.post(`${root}/:name/connect`, route(ctx, async (req, res) => {
    const p = project(ctx, req); confirmed(req.body); trusted(p); const name = slug.parse(param(req, 'name'));
    res.json(await withProjectLock(p.id, () => connectMcp(ctx, p, findConfig(ctx, p, name))));
  }));
  app.delete(`${root}/:name`, route(ctx, async (req, res) => {
    const p = project(ctx, req); confirmed(req.body); trusted(p); const name = slug.parse(param(req, 'name'));
    await withProjectLock(p.id, async () => {
      const config = findConfig(ctx, p, name); await ctx.engine.request(p.id, 'DELETE', `/api/experimental/mcp/${name}`);
      clearSecrets(ctx, p.id, name); ctx.store.remove('mcp', config.id); ctx.history(p.id, 'mcp', 'MCP supprimé', name);
    });
    res.json({ok: true});
  }));
}
