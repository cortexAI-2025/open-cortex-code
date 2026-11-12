import type { Express } from 'express';
import type { Project } from '../../shared/contracts.js';
import { z } from 'zod';
import { lstat } from 'node:fs/promises';
import { AdvancedError, type Context, all, confirmed, hash, id, label, now, owned, project, readSafe, redact, relativePath, route, safePath, trusted, withProjectLock, writeSafe } from './common.js';
import { git, gitOk } from './process.js';
import { isSensitivePath } from '../security.js';

export interface GitView { available: boolean; branch: string; status: string; log: { hash: string; message: string; date: string }[]; diff: string; truncated: boolean; detail?: string }
const safeDiffPaths = ['.', ...['**/.env*', '**/.npmrc', '**/.netrc', '**/.pypirc', '**/credentials*', '**/secrets*', '**/id_rsa*', '**/id_ed25519*', '**/id_ecdsa*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/.ssh/**', '**/.aws/**', '**/.azure/**', '**/.gcp/**', '**/.config/**', '**/.opencortex/**'].map(pattern => `:(exclude,glob)${pattern}`)];
export async function gitView(ctx: Context, p: Project): Promise<GitView> {
  try {
    const check = await git(p, ['rev-parse', '--show-toplevel']);
    if (check.exitCode !== 0) return { available: false, branch: '', status: '', log: [], diff: '', truncated: false, detail: 'Ce projet ne contient pas de dépôt Git disponible.' };
    // A subdirectory is not a repository boundary and must not leak files of the parent repository.
    if (check.output.trim() !== p.path) throw new AdvancedError(403, 'GIT_ROOT_MISMATCH', 'Ouvrir la racine réelle du dépôt Git.');
    const [branch, status, log, unstaged, staged] = await Promise.all([
      git(p, ['branch', '--show-current']), git(p, ['status', '--short', '--untracked-files=normal']),
      git(p, ['log', '-30', '--format=%H%x00%s%x00%cI']),
      git(p, ['diff', '--no-ext-diff', '--no-textconv', '--', ...safeDiffPaths]), git(p, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', ...safeDiffPaths]),
    ]);
    for (const result of [branch, status, unstaged, staged]) if (result.exitCode !== 0) throw new AdvancedError(409, 'GIT_FAILED', result.output);
    return { available: true, branch: branch.output.trim() || '(detached HEAD)', status: redact(ctx, status.output),
      log: log.exitCode === 0 ? log.output.trim().split('\n').filter(Boolean).map((line) => { const [h, message, date] = line.split('\0'); return { hash: h!, message: redact(ctx, message ?? ''), date: date ?? '' }; }) : [],
      diff: redact(ctx, `${unstaged.output}${staged.output ? '\n--- INDEX ---\n' + staged.output : ''}`),
      truncated: [status, log, unstaged, staged].some((r) => r.truncated || r.timedOut) };
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { available: false, branch: '', status: '', log: [], diff: '', truncated: false, detail: 'Git non installé.' }; throw e; }
}
interface SnapshotFile { path: string; hash: string; blobId: string; mode: number }
interface SnapshotBlob { id: string; projectId: string; content: string }
export interface Checkpoint { id: string; projectId: string; message: string; createdAt: string; files: SnapshotFile[]; excluded: string[] }
export const checkpointPublic = (c: Checkpoint) => ({ id: c.id, projectId: c.projectId, message: c.message, createdAt: c.createdAt, files: c.files.map(({path, hash, mode}) => ({path, hash, mode})), excluded: c.excluded, indexUnchanged: true });
function excludedFile(file: string): boolean {
  return isSensitivePath(file) || /(^|\/)(node_modules|\.git|\.cortex|dist|build)(\/|$)/.test(file);
}
export async function createCheckpoint(ctx: Context, p: Project, message = 'Checkpoint local'): Promise<Checkpoint> {
  const view = await gitView(ctx, p);
  if (!view.available) throw new AdvancedError(409, 'GIT_UNAVAILABLE', view.detail!);
  const files = (await gitOk(p, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], 2_000_000)).split('\0').filter(Boolean);
  if (files.length > 2000) throw new AdvancedError(413, 'CHECKPOINT_LIMIT', 'Checkpoint limité à 2000 fichiers.');
  let total = 0;
  const blobs: SnapshotBlob[] = [];
  const snapshot: SnapshotFile[] = [], excluded: string[] = [];
  for (const file of [...new Set(files)]) {
    relativePath(file);
    if (excludedFile(file)) { excluded.push(file); continue; }
    const bytes = await readSafe(p, file);
    if (!bytes) continue;
    if (redact(ctx, bytes.toString('utf8')) !== bytes.toString('utf8')) { excluded.push(file); continue; }
    total += bytes.length;
    if (total > 32_000_000) throw new AdvancedError(413, 'CHECKPOINT_LIMIT', 'Checkpoint limité à 32 Mo.');
    const info = await lstat(await safePath(p, file));
    const blobId = id();
    blobs.push({ id: blobId, projectId: p.id, content: bytes.toString('base64') });
    snapshot.push({ path: file, hash: hash(bytes), blobId, mode: info.mode & 0o777 });
  }
  const checkpoint: Checkpoint = { id: id(), projectId: p.id, message: redact(ctx, message), createdAt: now(), files: snapshot, excluded };
  try {
    for (const blob of blobs) ctx.store.put('checkpoint-blobs', blob, p.id);
    ctx.store.put('checkpoints', checkpoint, p.id);
  } catch (error) { for (const blob of blobs) ctx.store.remove('checkpoint-blobs', blob.id); throw error; }
  ctx.history(p.id, 'checkpoint', 'Copie locale créée', `${checkpoint.id} : ${snapshot.length} fichiers; ${excluded.length} exclus. Index inchangé.`);
  return checkpoint;
}
export async function restoreCheckpoint(ctx: Context, p: Project, input: unknown): Promise<unknown> {
  confirmed(input); trusted(p);
  const b = z.object({ checkpointId: z.string().min(1), confirm: z.literal(true), expectedHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/).nullable()).optional() }).strict().parse(input);
  return withProjectLock(p.id, async () => {
    trusted(ctx.project(p.id));
    const checkpoint = owned<Checkpoint>(ctx, 'checkpoints', b.checkpointId, p.id);
    const currentHashes: Record<string, string | null> = {};
    for (const file of checkpoint.files) {
      relativePath(file.path);
      const decoded = Buffer.from(owned<SnapshotBlob>(ctx, 'checkpoint-blobs', file.blobId, p.id).content, 'base64');
      if (hash(decoded) !== file.hash) throw new AdvancedError(409, 'CORRUPT_CHECKPOINT', 'Copie locale corrompue.');
      const current = await readSafe(p, file.path);
      currentHashes[file.path] = current ? hash(current) : null;
    }
    if (!b.expectedHashes) throw new AdvancedError(409, 'RESTORE_PREVIEW_REQUIRED', 'Examiner les fichiers et renvoyer expectedHashes pour restaurer.', { expectedHashes: currentHashes, paths: Object.keys(currentHashes) });
    if (Object.keys(b.expectedHashes).length !== checkpoint.files.length || checkpoint.files.some((f) => !(f.path in b.expectedHashes!) || b.expectedHashes![f.path] !== currentHashes[f.path]))
      throw new AdvancedError(409, 'FILE_CONFLICT', 'Les fichiers ont changé ou l’aperçu est incomplet.', { expectedHashes: currentHashes });
    const backup = await createCheckpoint(ctx, p, `Avant restauration ${checkpoint.id}`);
    const restored: string[] = [];
    try {
      for (const file of checkpoint.files) {
        const bytes = Buffer.from(owned<SnapshotBlob>(ctx, 'checkpoint-blobs', file.blobId, p.id).content, 'base64');
        await writeSafe(p, file.path, bytes, currentHashes[file.path]!, file.mode);
        restored.push(file.path);
      }
    } catch (error) {
      ctx.history(p.id, 'restore-error', 'Restauration interrompue', redact(ctx, JSON.stringify({ restored, backupId: backup.id, error: error instanceof Error ? error.message : String(error) })));
      throw new AdvancedError(409, 'RESTORE_INTERRUPTED', 'Restauration interrompue; consulter la copie de secours.', { restored, backupId: backup.id });
    }
    ctx.history(p.id, 'restore', 'Fichiers restaurés', `${checkpoint.id}; ${restored.length} fichiers; index/branche inchangés. Sauvegarde ${backup.id}.`);
    return { ok: true, restored, backupId: backup.id, indexUnchanged: true, newlyCreatedFilesPreserved: true };
  });
}
export function registerGitRoutes(app: Express, ctx: Context): void {
  app.get('/api/projects/:id/git', route(ctx, async (req, res) => res.json(await gitView(ctx, project(ctx, req)))));
  app.post('/api/projects/:id/git/branch', route(ctx, async (req, res) => {
    const p = project(ctx, req); confirmed(req.body); trusted(p);
    const b = z.object({ name: label, confirm: z.literal(true) }).strict().parse(req.body);
    if (b.name.startsWith('-')) throw new AdvancedError(400, 'INVALID_BRANCH', 'Nom de branche invalide.');
    await withProjectLock(p.id, async () => {
      const view = await gitView(ctx, p); if (!view.available) throw new AdvancedError(409, 'GIT_UNAVAILABLE', 'Dépôt Git requis.');
      await gitOk(p, ['check-ref-format', '--branch', b.name]);
      await gitOk(p, ['branch', '--', b.name]);
      ctx.history(p.id, 'branch', 'Branche créée (sans checkout)', b.name);
    });
    res.json({ ok: true, name: b.name, switched: false });
  }));
  app.get('/api/projects/:id/git/checkpoints', route(ctx, (req, res) => { const p = project(ctx, req); res.json(all<Checkpoint>(ctx, 'checkpoints', p.id).map(checkpointPublic)); }));
  app.post('/api/projects/:id/git/checkpoint', route(ctx, async (req, res) => {
    const p = project(ctx, req); confirmed(req.body);
    const b = z.object({ message: label.optional(), confirm: z.literal(true) }).strict().parse(req.body);
    res.json(checkpointPublic(await withProjectLock(p.id, () => createCheckpoint(ctx, p, b.message))));
  }));
  app.post('/api/projects/:id/git/restore', route(ctx, async (req, res) => res.json(await restoreCheckpoint(ctx, project(ctx, req), req.body))));
}
