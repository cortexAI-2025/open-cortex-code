import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeSync, ftruncateSync } from 'node:fs';
import { lstat, realpath, open, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import type { ConnectorContext } from '../context.js';
import type { Project, Profile } from '../../shared/contracts.js';

export type Context = ConnectorContext;
export class AdvancedError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) { super(message); }
}
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const text = z.string().trim().min(1).max(200_000);
export const aiText = z.string().trim().min(1).max(48_000);
export const label = z.string().trim().min(1).max(200);
export const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
export const confirmed = (body: unknown) => {
  if (!body || typeof body !== 'object' || (body as { confirm?: unknown }).confirm !== true)
    throw new AdvancedError(403, 'CONFIRM_REQUIRED', 'Confirmation explicite confirm:true requise.');
};
export function redact(ctx: Context, value: string): string {
  return ctx.vault.redact(value)
    .replace(/(Bearer\s+)[\w.+/=:-]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret|authorization)\s*[=:]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{16,})\b/g, '[REDACTED]');
}
export function route(ctx: Context, fn: (req: Request, res: Response) => unknown | Promise<unknown>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve().then(() => fn(req, res)).catch((error: unknown) => {
      if (res.headersSent) { next(error); return; }
      if (error instanceof z.ZodError) { res.status(400).json({ error: 'Paramètres invalides.', code: 'VALIDATION' }); return; }
      if (error instanceof AdvancedError) { res.status(error.status).json({ error: redact(ctx, error.message), code: error.code, ...error.extra }); return; }
      const e = error as { status?: number; statusCode?: number; code?: string; message?: string };
      const status = e.status ?? e.statusCode;
      res.status(status && status >= 400 && status <= 599 ? status : 500).json({ error: redact(ctx, e.message ?? 'Erreur avancée.'), code: e.code ?? 'ADVANCED_ERROR' });
    });
  };
}
export function param(req: Request, name: string): string {
  const result = req.params[name];
  if (typeof result !== 'string' || !result || result.length > 200) throw new AdvancedError(400, 'VALIDATION', 'Identifiant invalide.');
  return result;
}
export function project(ctx: Context, req: Request): Project { return ctx.project(param(req, 'id')); }
export function trusted(p: Project): void {
  if (!p.trusted) throw new AdvancedError(403, 'UNTRUSTED_PROJECT', 'Exécution refusée : projet non approuvé. Un worktree ne constitue pas un sandbox.');
}
export function owned<T extends { id: string; projectId: string }>(ctx: Context, kind: string, entityId: string, projectId: string): T {
  ctx.project(projectId);
  const entry = ctx.store.get<T>(kind, entityId);
  if (!entry || entry.projectId !== projectId) throw new AdvancedError(404, 'NOT_FOUND', 'Élément introuvable dans ce projet.');
  return entry;
}
export function all<T extends { projectId: string }>(ctx: Context, kind: string, projectId: string): T[] {
  ctx.project(projectId);
  return ctx.store.all<T>(kind, projectId).filter((entry) => entry.projectId === projectId);
}
export function requireProfile(ctx: Context, profileId: string): Profile {
  const profile = ctx.store.get<Profile>('profiles', profileId);
  if (!profile) throw new AdvancedError(404, 'PROFILE_NOT_FOUND', 'Profil introuvable.');
  let local = false;
  if (profile.baseUrl) {
    const endpoint = new URL(profile.baseUrl);
    local = endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(endpoint.hostname);
  }
  if (!ctx.vault.get(profileId) && !local) throw new AdvancedError(503, 'PROFILE_SECRET_REQUIRED', 'Le profil doit disposer d’une clé réelle dans le coffre local, sauf serveur loopback explicitement configuré.');
  return profile;
}
export function relativePath(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || path.isAbsolute(value) || /^[A-Za-z]:/.test(value))
    throw new AdvancedError(400, 'INVALID_PATH', 'Chemin relatif requis.');
  const parts = value.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git'))
    throw new AdvancedError(400, 'INVALID_PATH', 'Chemin invalide ou métadonnées Git interdites.');
  return parts.join('/');
}
export async function safePath(p: Project, rel: string, createParents = false): Promise<string> {
  const valid = relativePath(rel);
  const root = await realpath(p.path);
  if (root !== path.resolve(p.path)) throw new AdvancedError(409, 'PROJECT_PATH_CHANGED', 'Le chemin réel du projet a changé.');
  const segments = valid.split('/');
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]!);
    const info = await lstat(current).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return undefined; throw e; });
    if (info?.isSymbolicLink()) throw new AdvancedError(403, 'SYMLINK_BLOCKED', 'Lien symbolique refusé.');
    if (i < segments.length - 1) {
      if (!info && createParents) await mkdir(current, { mode: 0o700 });
      else if (!info) continue;
      else if (!info.isDirectory()) throw new AdvancedError(400, 'INVALID_PATH', 'Parent non répertoire.');
    } else if (info && !info.isFile()) throw new AdvancedError(403, 'NOT_REGULAR_FILE', 'Fichier régulier requis.');
  }
  return current;
}
export async function readSafe(p: Project, rel: string, max = 2_000_000): Promise<Buffer | undefined> {
  const target = await safePath(p, rel);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return undefined; throw e; });
  if (!handle) return;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink > 1) throw new AdvancedError(403, 'FILE_TYPE_DENIED', 'Fichier non régulier ou hardlink refusé.');
    if (info.size > max) throw new AdvancedError(413, 'FILE_TOO_LARGE', 'Fichier trop volumineux.');
    if (process.platform === 'linux' && await realpath(`/proc/self/fd/${handle.fd}`) !== target) throw new AdvancedError(403, 'PATH_DENIED', 'Descripteur hors projet.');
    const bytes = await handle.readFile();
    const named = await lstat(target);
    if (named.dev !== info.dev || named.ino !== info.ino || named.isSymbolicLink()) throw new AdvancedError(409, 'FILE_CONFLICT', 'Fichier remplacé pendant la lecture.');
    return bytes;
  }
  finally { await handle.close(); }
}
export async function writeSafe(p: Project, rel: string, content: Buffer, expected: string | null, mode?: number): Promise<void> {
  const target = await safePath(p, rel, true);
  let fd: number;
  try { fd = openSync(target, constants.O_NOFOLLOW | constants.O_RDWR | (expected === null ? constants.O_CREAT | constants.O_EXCL : 0), 0o600); }
  catch (e) { if (['ENOENT', 'EEXIST', 'ELOOP'].includes((e as NodeJS.ErrnoException).code ?? '')) throw new AdvancedError(409, 'FILE_CONFLICT', 'Fichier créé, disparu ou remplacé depuis l’aperçu.'); throw e; }
  try {
    const info = fstatSync(fd), named = lstatSync(target);
    if (!info.isFile() || info.nlink > 1 || named.isSymbolicLink()) throw new AdvancedError(403, 'FILE_TYPE_DENIED', 'Fichier non régulier ou hardlink refusé.');
    if (info.size > 2_000_000 || content.length > 2_000_000) throw new AdvancedError(413, 'FILE_TOO_LARGE', 'Fichier trop volumineux.');
    if (info.dev !== named.dev || info.ino !== named.ino || process.platform === 'linux' && realpathSync(`/proc/self/fd/${fd}`) !== target) throw new AdvancedError(403, 'PATH_DENIED', 'Fichier remplacé ou hors projet.');
    const current = readFileSync(fd);
    if (expected !== null && hash(current) !== expected) throw new AdvancedError(409, 'FILE_CONFLICT', 'Modification concurrente détectée.', { path: rel, currentHash: hash(current) });
    // Synchronous descriptor-bound section: core file writes cannot interleave on this event loop.
    let offset = 0;
    while (offset < content.length) offset += writeSync(fd, content, offset, content.length - offset, offset);
    ftruncateSync(fd, content.length); if (mode !== undefined) fchmodSync(fd, mode & 0o777); fsyncSync(fd);
  } finally { closeSync(fd); }
}
const locks = new Map<string, Promise<unknown>>();
export async function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(projectId) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(fn);
  locks.set(projectId, operation);
  try { return await operation; } finally { if (locks.get(projectId) === operation) locks.delete(projectId); }
}
export function data<T>(response: unknown): T {
  return (response && typeof response === 'object' && 'data' in response ? (response as {data: unknown}).data : response) as T;
}
