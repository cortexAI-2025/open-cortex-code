import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { Express } from 'express';
import { z } from 'zod';
import { AdvancedError, type Context, all, confirmed, id, label, now, owned, param, project, redact, route } from './common.js';

const publicHeaders = new Set(['accept', 'accept-language', 'content-type']);
const secretHeaders = new Set(['authorization', 'x-api-key', 'api-key']);
export function validateHeaders(input: Record<string, string> = {}, sensitive = false): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase();
    if (!(sensitive ? secretHeaders : publicHeaders).has(key) || /[\r\n\0]/.test(value) || value.length > 4096)
      throw new AdvancedError(400, 'HEADER_DENIED', 'Header non autorisé ou invalide.');
    if (key in output) throw new AdvancedError(400, 'HEADER_DENIED', 'Header dupliqué.');
    output[key] = value;
  }
  return output;
}
export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}
export function isPublicAddress(address: string): boolean {
  const ip = address.toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && (b === 168 || b === 0) || a === 100 && b! >= 64 && b! <= 127 || a! >= 224 || a === 198 && (b === 18 || b === 19));
  }
  if (isIP(ip) === 6) return /^[23][0-9a-f]{3}:/.test(ip) && !ip.startsWith('2001:db8:') && !ip.startsWith('2002:') && !ip.startsWith('2001:0:');
  return false;
}
export function validateUrl(value: string, allowLoopback = false): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AdvancedError(400, 'INVALID_URL', 'URL absolue requise.'); }
  if (url.username || url.password || url.hash || /[\r\n\0]/.test(value) || url.search)
    throw new AdvancedError(400, 'URL_CREDENTIALS_DENIED', 'URL sans identifiants, query ni fragment requise.');
  if (isLoopback(url.hostname)) {
    if (!allowLoopback || !['https:', 'http:'].includes(url.protocol)) throw new AdvancedError(403, 'LOOPBACK_CONSENT_REQUIRED', 'Loopback nécessite allowLoopback:true.');
  } else if (url.protocol !== 'https:') throw new AdvancedError(400, 'HTTPS_REQUIRED', 'HTTPS requis hors loopback.');
  if (!isLoopback(url.hostname) && isIP(url.hostname.replace(/[\[\]]/g, '')) && !isPublicAddress(url.hostname.replace(/[\[\]]/g, '')))
    throw new AdvancedError(403, 'PRIVATE_NETWORK_DENIED', 'Réseau privé non loopback refusé.');
  return url;
}
export async function resolveTarget(url: URL, allowLoopback: boolean): Promise<{ address: string; family: number }> {
  const hostname = url.hostname.replace(/[\[\]]/g, '');
  const records = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some((r) => isLoopback(url.hostname) ? !allowLoopback || !['127.0.0.1', '::1'].includes(r.address) : !isPublicAddress(r.address)))
    throw new AdvancedError(403, 'PRIVATE_NETWORK_DENIED', 'Résolution DNS non autorisée.');
  return records[0]!;
}
export interface RestProfile { id: string; projectId: string; name: string; baseUrl: string; method: 'GET' | 'HEAD'; path: string; headers: Record<string, string>; allowLoopback: boolean; hasSecret: boolean; createdAt: string }
const restSchema = z.object({ name: label, baseUrl: z.string().max(2048), method: z.enum(['GET', 'HEAD']), path: z.string().max(2048).default('/'), headers: z.record(z.string(), z.string()).optional(), apiKey: z.string().min(1).max(4096).optional(), allowLoopback: z.boolean().default(false) }).strict();
const restSecretId = (p: string, i: string) => `advanced:api:${p}:${i}`;
export function restTarget(profile: RestProfile): URL {
  const base = validateUrl(profile.baseUrl, profile.allowLoopback);
  if (!profile.path.startsWith('/') || profile.path.startsWith('//') || profile.path.includes('\\') || profile.path.includes('#') || /[\r\n\0]/.test(profile.path))
    throw new AdvancedError(400, 'INVALID_API_PATH', 'Chemin endpoint relatif à l’origine requis.');
  const url = new URL(profile.path, base);
  if (url.origin !== base.origin || /(?:api[_-]?key|token|secret|password|authorization)/i.test(url.search)) throw new AdvancedError(400, 'INVALID_API_PATH', 'Identifiants dans URL ou changement d’origine refusés.');
  return url;
}
export async function testRest(ctx: Context, profile: RestProfile): Promise<{ok: boolean; status: number; detail: string; durationMs: number; truncated: boolean}> {
  ctx.project(profile.projectId);
  if (profile.method !== 'GET' && profile.method !== 'HEAD') throw new AdvancedError(403, 'METHOD_DENIED', 'Seuls GET et HEAD sont testables.');
  const url = restTarget(profile), target = await resolveTarget(url, profile.allowLoopback);
  const key = ctx.vault.get(restSecretId(profile.projectId, profile.id));
  const headers = { ...validateHeaders(profile.headers), ...(key ? { authorization: `Bearer ${key}` } : {}) };
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const invoke = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = invoke(url, { method: profile.method, headers, agent: false,
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
    }, (res) => {
      const status = res.statusCode ?? 0;
      const parts: Buffer[] = []; let size = 0, truncated = false;
      res.on('data', (chunk: Buffer) => { const limit = 65536; if (size < limit) parts.push(chunk.subarray(0, limit - size)); size += chunk.length; if (size > limit) { truncated = true; res.destroy(); finish(); } });
      let done = false;
      const finish = () => {
        if (done) return; done = true; clearTimeout(timer);
        resolve({ ok: status >= 200 && status < 300, status, detail: redact(ctx, Buffer.concat(parts).toString('utf8')), durationMs: Date.now() - start, truncated });
      };
      res.on('end', finish); res.on('error', (error) => { if (!truncated) { clearTimeout(timer); reject(new AdvancedError(502, 'API_NETWORK_ERROR', redact(ctx, error.message))); } });
      if (status >= 300 && status < 400) { res.destroy(); clearTimeout(timer); reject(new AdvancedError(502, 'REDIRECT_DENIED', 'Redirection distante refusée.')); }
    });
    const timer = setTimeout(() => req.destroy(new Error('Délai réseau dépassé.')), 10_000);
    req.on('error', (error) => { clearTimeout(timer); reject(new AdvancedError(502, 'API_NETWORK_ERROR', redact(ctx, error.message))); });
    req.end();
  });
}
export function registerApiRoutes(app: Express, ctx: Context): void {
  const root = '/api/projects/:id/apis';
  app.get(root, route(ctx, (req, res) => { const p = project(ctx, req); res.json(all<RestProfile>(ctx, 'apis', p.id).map((api) => ({ ...api, hasSecret: Boolean(ctx.vault.get(restSecretId(p.id, api.id))) }))); }));
  app.post(root, route(ctx, (req, res) => {
    const p = project(ctx, req), body = restSchema.parse(req.body);
    const profile: RestProfile = { id: id(), projectId: p.id, name: body.name, baseUrl: validateUrl(body.baseUrl, body.allowLoopback).href, method: body.method, path: body.path, headers: validateHeaders(body.headers), allowLoopback: body.allowLoopback, hasSecret: Boolean(body.apiKey), createdAt: now() };
    restTarget(profile);
    if (body.apiKey) { if (/[\r\n\0]/.test(body.apiKey)) throw new AdvancedError(400, 'INVALID_SECRET', 'Secret invalide.'); ctx.vault.set(restSecretId(p.id, profile.id), body.apiKey); }
    ctx.store.put('apis', profile, p.id); ctx.history(p.id, 'api', 'Profil REST créé (non testé)', profile.name); res.status(201).json(profile);
  }));
  app.put(`${root}/:apiId/secret`, route(ctx, (req, res) => {
    const p = project(ctx, req); confirmed(req.body); const api = owned<RestProfile>(ctx, 'apis', param(req, 'apiId'), p.id);
    const b = z.object({ apiKey: z.string().min(1).max(4096).refine((s) => !/[\r\n\0]/.test(s)), confirm: z.literal(true) }).strict().parse(req.body);
    ctx.vault.set(restSecretId(p.id, api.id), b.apiKey); res.json({ hasSecret: true });
  }));
  app.delete(`${root}/:apiId`, route(ctx, (req, res) => {
    const p = project(ctx, req); confirmed(req.body); const api = owned<RestProfile>(ctx, 'apis', param(req, 'apiId'), p.id);
    ctx.vault.delete(restSecretId(p.id, api.id)); ctx.store.remove('apis', api.id); ctx.history(p.id, 'api', 'Profil REST supprimé', api.name); res.json({ ok: true });
  }));
  app.post(`${root}/:apiId/test`, route(ctx, async (req, res) => {
    const p = project(ctx, req); confirmed(req.body); const api = owned<RestProfile>(ctx, 'apis', param(req, 'apiId'), p.id);
    const result = await testRest(ctx, api); ctx.history(p.id, 'api-test', 'Test REST réel', `${api.name}: HTTP ${result.status}`);
    if (!result.ok) throw new AdvancedError(502, 'API_HTTP_ERROR', `Endpoint répond HTTP ${result.status}.`, { remoteStatus: result.status });
    res.json(result);
  }));
}
