import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync, writeSync, ftruncateSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FileContent, FileNode, Project } from '../shared/contracts.js';
import { hashContent, HttpError, isSensitivePath, MAX_FILE_BYTES, NOFOLLOW, resolveProjectPath } from './security.js';
import type { ConnectorContext } from './context.js';

function readBuffer(fd: number): Buffer {
  const size = fstatSync(fd).size;
  if (size > MAX_FILE_BYTES) throw new HttpError(413, 'Fichier trop volumineux.', 'FILE_TOO_LARGE');
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, buffer, offset, size - offset, offset);
    if (!count) throw new HttpError(409, 'Fichier tronqué pendant l’accès.', 'FILE_CHANGED');
    offset += count;
  }
  return buffer;
}
function validateHandle(fd: number, target: string, project: Project): void {
  const info = fstatSync(fd);
  if (!info.isFile() || info.nlink > 1) throw new HttpError(403, 'Fichier non régulier ou hardlink refusé.', 'FILE_TYPE_DENIED');
  if (info.size > MAX_FILE_BYTES) throw new HttpError(413, 'Fichier trop volumineux.', 'FILE_TOO_LARGE');
  resolveProjectPath(project.path, path.relative(project.path, target));
  const named = lstatSync(target);
  if (named.dev !== info.dev || named.ino !== info.ino) throw new HttpError(409, 'Fichier remplacé pendant l’accès.', 'FILE_CHANGED');
  if (process.platform === 'linux' && realpathSync(`/proc/self/fd/${fd}`) !== target) throw new HttpError(403, 'Descripteur hors projet refusé.', 'PATH_DENIED');
}
export function listFiles(project: Project, relative = ''): FileNode[] {
  const target = resolveProjectPath(project.path, relative);
  if (!statSync(target).isDirectory()) throw new HttpError(400, 'Répertoire attendu.', 'NOT_DIRECTORY');
  const entries = readdirSync(target, { withFileTypes: true });
  if (entries.length > 5000) throw new HttpError(413, 'Répertoire trop volumineux. Ouvrir un sous-répertoire.', 'DIRECTORY_TOO_LARGE');
  return entries.filter((entry) => !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()) && !isSensitivePath(entry.name)).map((entry): FileNode => ({ name: entry.name, path: [relative.replace(/\/$/u, ''), entry.name].filter(Boolean).join('/'), type: entry.isDirectory() ? 'directory' : 'file' })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
}
export function readFile(project: Project, relative: string): FileContent {
  const target = resolveProjectPath(project.path, relative);
  const fd = openSync(target, constants.O_RDONLY | NOFOLLOW);
  try {
    validateHandle(fd, target, project);
    const buffer = readBuffer(fd);
    if (buffer.includes(0)) throw new HttpError(415, 'Fichier binaire non éditable.', 'BINARY_FILE');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { path: relative, content, hash: hashContent(buffer) };
  } catch (error) { if (error instanceof TypeError) throw new HttpError(415, 'Encodage UTF-8 requis.', 'FILE_ENCODING'); throw error; }
  finally { closeSync(fd); }
}
interface StoredFileCheckpoint { id: string; projectId: string; path: string; content: string; hash: string; createdAt: string; source: string }
export function listFileCheckpoints(ctx: ConnectorContext, project: Project, relative: string): { id: string; path: string; preview: string; hash: string; createdAt: string }[] {
  if (!relative) throw new HttpError(400, 'Chemin de fichier requis.', 'INVALID_PATH');
  const target = resolveProjectPath(project.path, relative);
  if (!statSync(target).isFile()) throw new HttpError(400, 'Fichier attendu.', 'NOT_FILE');
  return ctx.store.all<StoredFileCheckpoint>('file-checkpoints', project.id).filter(item => item.projectId === project.id && item.path === relative && !isSensitivePath(item.path)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20).map(({ id, path: itemPath, content, hash, createdAt }) => ({ id, path: itemPath, preview: content.slice(0, 12_000), hash, createdAt }));
}
export function restoreFileCheckpoint(ctx: ConnectorContext, project: Project, input: { id: string; path: string; expectedHash: string; confirm: true }): FileContent {
  if (!project.trusted) throw new HttpError(403, 'Restauration refusée sur projet non approuvé.', 'UNTRUSTED_PROJECT');
  const checkpoint = ctx.store.get<StoredFileCheckpoint>('file-checkpoints', input.id);
  if (!checkpoint || checkpoint.projectId !== project.id || checkpoint.path !== input.path || isSensitivePath(checkpoint.path)) throw new HttpError(404, 'Point de restauration absent de ce projet.', 'CHECKPOINT_NOT_FOUND');
  if (hashContent(checkpoint.content) !== checkpoint.hash) throw new HttpError(409, 'Point de restauration corrompu.', 'CHECKPOINT_CORRUPT');
  return writeFile(ctx, project, { path: checkpoint.path, content: checkpoint.content, hash: input.expectedHash, confirm: input.confirm });
}
export function writeFile(ctx: ConnectorContext, project: Project, input: { path: string; content: string; hash: string; confirm: true }): FileContent {
  if (!project.trusted) throw new HttpError(403, 'Mutation refusée sur projet non approuvé.', 'UNTRUSTED_PROJECT');
  if (Buffer.byteLength(input.content) > MAX_FILE_BYTES) throw new HttpError(413, 'Fichier trop volumineux.', 'FILE_TOO_LARGE');
  const target = resolveProjectPath(project.path, input.path);
  // Open once, retain its identity through comparison and mutation. No unlink/rename traversal.
  const fd = openSync(target, constants.O_RDWR | NOFOLLOW);
  try {
    validateHandle(fd, target, project);
    const before = readBuffer(fd);
    const hash = hashContent(before);
    if (input.hash !== hash) throw new HttpError(409, 'Le fichier a changé. Recharger avant sauvegarde.', 'HASH_CONFLICT');
    const previous = new TextDecoder('utf-8', { fatal: true }).decode(before);
    if (ctx.vault.redact(previous) !== previous || ctx.vault.redact(input.content) !== input.content) throw new HttpError(403, 'Secret détecté : édition et sauvegarde durable refusées.', 'SENSITIVE_CONTENT');
    const checkpoint = { id: randomUUID(), projectId: project.id, path: input.path, content: previous, hash, createdAt: new Date().toISOString(), source: 'file-put' };
    ctx.store.put('file-checkpoints', checkpoint, project.id);
    validateHandle(fd, target, project);
    // Verify a second time after checkpoint persistence.
    if (hashContent(readBuffer(fd)) !== hash) throw new HttpError(409, 'Fichier modifié pendant la sauvegarde.', 'HASH_CONFLICT');
    const bytes = Buffer.from(input.content);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    ftruncateSync(fd, bytes.length); fsyncSync(fd);
    ctx.history(project.id, 'file-write', 'Fichier sauvegardé', `${input.path}; checkpoint=${checkpoint.id}; ancien=${hash}; nouveau=${hashContent(bytes)}`);
    return { path: input.path, content: input.content, hash: hashContent(bytes) };
  } finally { closeSync(fd); }
}
