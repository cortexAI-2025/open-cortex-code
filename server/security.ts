import { createHash, timingSafeEqual } from 'node:crypto';
import { constants, existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { RequestHandler } from 'express';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = 'REQUEST_FAILED') { super(message); }
}
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const NOFOLLOW = constants.O_NOFOLLOW || 0;
export function hashContent(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export function isLoopback(host: string): boolean { return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host.toLowerCase()); }
export function isSensitivePath(relative: string): boolean {
  return relative.split(/[\\/]/u).some((part) => /^(?:\.env.*|\.git|\.ssh|\.aws|\.azure|\.gcp|\.config|\.opencortex|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|\.npmrc|\.netrc|\.pypirc|.*\.(?:pem|key|p12|pfx))$/iu.test(part));
}
/** Strictly reject symlinks, even those currently pointing inside the project. */
export function resolveProjectPath(projectPath: string, relativePath = '', allowMissing = false): string {
  if (typeof relativePath !== 'string' || relativePath.length > 4096 || /[\0\\]/u.test(relativePath) || path.isAbsolute(relativePath) || relativePath.split('/').includes('..')) {
    throw new HttpError(403, 'Chemin hors du projet refusé.', 'PATH_DENIED');
  }
  if (isSensitivePath(relativePath)) throw new HttpError(403, 'Fichier sensible refusé.', 'SENSITIVE_FILE');
  let root: string;
  try { root = realpathSync(projectPath); } catch { throw new HttpError(404, 'Projet absent.', 'PROJECT_NOT_FOUND'); }
  if (root !== path.resolve(projectPath) || !statSync(root).isDirectory()) throw new HttpError(403, 'Racine du projet modifiée ou invalide.', 'PATH_DENIED');
  const parts = relativePath.split('/').filter((part) => part && part !== '.');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    if (!existsSync(current)) {
      // existsSync follows a dangling symlink, so lstat is still mandatory.
      try { if (lstatSync(current).isSymbolicLink()) throw new HttpError(403, 'Lien symbolique refusé.', 'SYMLINK_DENIED'); }
      catch (error) { if (error instanceof HttpError) throw error; }
      if (allowMissing && index === parts.length - 1) return current;
      throw new HttpError(404, 'Fichier absent.', 'FILE_NOT_FOUND');
    }
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new HttpError(403, 'Lien symbolique refusé.', 'SYMLINK_DENIED');
    if (index < parts.length - 1 && !info.isDirectory()) throw new HttpError(400, 'Parent non répertoire.', 'PATH_INVALID');
    if (realpathSync(current) !== current) throw new HttpError(403, 'Chemin modifié.', 'PATH_DENIED');
  }
  return current;
}
export function safeToolchainPath(): string {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const system = process.platform === 'win32' ? [`${root}\\System32`, root] : ['/usr/local/bin', '/usr/bin', '/bin'];
  const candidates = [path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter), ...system];
  const directories = candidates.filter((entry) => {
    if (!entry || !path.isAbsolute(entry) || /[\0\r\n]/u.test(entry)) return false;
    try { return statSync(entry).isDirectory(); } catch { return false; }
  });
  return [...new Set(directories)].join(path.delimiter);
}
export function safeEnvironment(privateHome = path.join(os.tmpdir(), 'opencortex-empty-home')): NodeJS.ProcessEnv {
  // No spread of process.env: API tokens, proxy settings and cloud/Manus credentials never enter a child.
  const root = process.env.SystemRoot || 'C:\\Windows';
  const env: NodeJS.ProcessEnv = {
    PATH: safeToolchainPath(),
    HOME: privateHome, USERPROFILE: privateHome, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    TMPDIR: path.join(privateHome, 'tmp'), TMP: path.join(privateHome, 'tmp'), TEMP: path.join(privateHome, 'tmp'),
    XDG_CONFIG_HOME: path.join(privateHome, 'config'), XDG_DATA_HOME: path.join(privateHome, 'data'),
    XDG_CACHE_HOME: path.join(privateHome, 'cache'), XDG_STATE_HOME: path.join(privateHome, 'state'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0', NODE_ENV: 'production',
  };
  if (process.platform === 'win32') { env.SystemRoot = root; env.WINDIR = root; }
  return env;
}
export interface NetworkGuardOptions {
  token: string;
  port: () => number;
  host: string;
  allowedOrigins?: string[];
  canUseRemoteOrigin?: (origin: string) => boolean;
  authenticateRemote?: (token: string, origin: string) => boolean;
  canRevokeRemotePairing?: (token: string, origin: string, id: string) => boolean;
  allowPairingRoute?: (origin: string, path: string, method: string) => boolean;
}
function isRemoteSecretMutation(method: string, urlPath: string): boolean {
  if (method === 'POST' && urlPath === '/api/profiles') return true;
  if (/^\/api\/profiles\/[^/]+\/secret$/u.test(urlPath)) return true;
  if (method === 'POST' && /^\/api\/projects\/[^/]+\/(?:mcp|apis)$/u.test(urlPath)) return true;
  if (urlPath.endsWith('/secret') && /^\/api\/projects\/[^/]+\/(?:mcp|apis)\//u.test(urlPath)) return true;
  return false;
}
export function networkGuard(options: NetworkGuardOptions): RequestHandler {
  return (req, res, next) => {
    const actualHost = req.headers.host;
    const port = options.port();
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    if (!actualHost || !allowedHosts.has(actualHost.toLowerCase())) return next(new HttpError(403, 'Host refusé.', 'HOST_DENIED'));
    const origin = req.headers.origin;
    const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`, ...(options.allowedOrigins || [])]);
    const localOrigin = !origin || origins.has(origin);
    const requestedMethod = (req.headers['access-control-request-method'] || '').toString().toUpperCase();
    const pairRoute = Boolean(origin && options.allowPairingRoute?.(origin, req.path, req.method === 'OPTIONS' ? requestedMethod : req.method));
    const pairedOrigin = Boolean(origin && options.canUseRemoteOrigin?.(origin));
    if (origin && !localOrigin && !pairRoute && !pairedOrigin) return next(new HttpError(403, 'Origin refusée.', 'ORIGIN_DENIED'));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (origin && (localOrigin || pairRoute || pairedOrigin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.vary('Origin'); }
    if (req.method === 'OPTIONS') {
      const methodAllowed = localOrigin
        ? ['GET', 'POST', 'PUT', 'DELETE'].includes(requestedMethod)
        : pairRoute || (pairedOrigin && ['GET', 'POST', 'PUT', 'DELETE'].includes(requestedMethod));
      const requestedHeaders = (req.headers['access-control-request-headers'] || '').toString().split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
      const headerAllowlist = pairRoute && !pairedOrigin ? ['content-type'] : ['authorization', 'content-type'];
      const headersAllowed = requestedHeaders.every((header) => headerAllowlist.includes(header));
      const privateNetwork = req.headers['access-control-request-private-network'];
      if (!origin || (!localOrigin && !pairRoute && !pairedOrigin) || !methodAllowed || !headersAllowed || (privateNetwork !== undefined && privateNetwork !== 'true')) {
        return next(new HttpError(403, 'Preflight refusé.', 'PREFLIGHT_DENIED'));
      }
      res.setHeader('Access-Control-Allow-Methods', requestedMethod);
      if (requestedHeaders.length) res.setHeader('Access-Control-Allow-Headers', requestedHeaders.map((header) => header === 'content-type' ? 'Content-Type' : 'Authorization').join(', '));
      if (privateNetwork === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Access-Control-Max-Age', '0');
      res.vary('Access-Control-Request-Method'); res.vary('Access-Control-Request-Headers');
      res.status(204).end(); return;
    }
    if (!req.path.startsWith('/api/')) return next();
    if (origin && !localOrigin && pairRoute) return next();
    if (req.path === '/api/health' && req.method === 'GET' && localOrigin) return next();
    const provided = (req.headers.authorization || '').startsWith('Bearer ') ? (req.headers.authorization || '').slice(7) : '';
    if (origin && !localOrigin) {
      if (isRemoteSecretMutation(req.method, req.path)) return next(new HttpError(403, 'La configuration des credentials est réservée à l’interface locale.', 'REMOTE_SECRET_DENIED'));
      if (req.path.startsWith('/api/pair/')) {
        const match = req.path.match(/^\/api\/pair\/sessions\/([0-9a-f-]{36})$/iu);
        if (req.method === 'DELETE' && match && provided && options.canRevokeRemotePairing?.(provided, origin, match[1]!)) return next();
        return next(new HttpError(403, 'La gestion des pairings est réservée à l’interface locale, hors révocation de sa propre session.', 'REMOTE_PAIRING_ADMIN_DENIED'));
      }
      if (!provided || !options.authenticateRemote?.(provided, origin)) return next(new HttpError(401, 'Jeton distant invalide, expiré ou lié à une autre origine.', 'REMOTE_UNAUTHORIZED'));
      return next();
    }
    const expected = Buffer.from(options.token);
    const actual = Buffer.from(provided);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return next(new HttpError(401, 'Pairing local requis.', 'UNAUTHORIZED'));
    return next();
  };
}
export function validateBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400, 'URL fournisseur invalide.', 'INVALID_URL'); }
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname)))) {
    throw new HttpError(400, 'URL HTTPS ou fournisseur loopback sans credentials requis.', 'INVALID_URL');
  }
  if (!isLoopback(url.hostname) && /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?f[cd]|\[?fe80)/iu.test(url.hostname)) {
    throw new HttpError(400, 'Adresse réseau privée distante refusée.', 'INVALID_URL');
  }
  return url.toString().replace(/\/$/u, '');
}
