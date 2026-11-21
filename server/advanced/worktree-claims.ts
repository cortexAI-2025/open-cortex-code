import type { Express } from 'express';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Project } from '../../shared/contracts.js';
import { AdvancedError, type Context, confirmed, owned, param, project, route, trusted } from './common.js';
import { detectClaimConflicts, normalizeClaimPath, type FileClaim } from './conflicts.js';
import { storeMission, type Mission } from './mission.js';
import { gitOk } from './process.js';

export interface WorktreeChange { path: string; status: 'modified' | 'added' | 'deleted' | 'renamed'; from?: string }

export function parsePorcelainZ(raw: string): { changes: WorktreeChange[]; rejected: string[] } {
  const records = raw.split('\0');
  const changes: WorktreeChange[] = [];
  const rejected: string[] = [];
  const push = (file: string, status: WorktreeChange['status'], from?: string) => {
    try {
      const normalized = normalizeClaimPath(file);
      const previous = from ? normalizeClaimPath(from) : undefined;
      changes.push({ path: normalized, status, ...(previous ? { from: previous } : {}) });
    } catch { rejected.push(file); }
  };
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const filename = record.slice(3);
    if (!filename) { rejected.push(record); continue; }
    if (status.includes('R') || status.includes('C')) {
      // porcelain v1 -z (Git 2.39) : « XY nouveau\0ancien\0 », inverse du format « ancien -> nouveau ».
      const previous = records[index + 1] ?? '';
      index += 1;
      if (!previous) { rejected.push(filename); continue; }
      push(filename, 'renamed', previous);
      continue;
    }
    if (status.includes('D')) push(filename, 'deleted');
    else if (status.includes('A') || status.includes('?')) push(filename, 'added');
    else push(filename, 'modified');
  }
  return { changes, rejected };
}

export function claimsFromChanges(agentId: string, changes: WorktreeChange[]): string[] {
  const paths = new Set<string>();
  for (const change of changes) {
    paths.add(change.path);
    if (change.from) paths.add(change.from);
  }
  return [...paths].sort();
}

async function safeWorktree(root: Project, location: string): Promise<Project> {
  const resolved = path.resolve(location);
  const info = await lstat(resolved).catch(() => undefined);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new AdvancedError(403, 'UNSAFE_WORKTREE_PATH', 'Worktree absent ou lien symbolique.');
  if (await realpath(resolved) !== resolved) throw new AdvancedError(403, 'UNSAFE_WORKTREE_PATH', 'Worktree hors chemin réel.');
  return { ...root, path: resolved };
}

export async function changedPaths(target: Project): Promise<{ changes: WorktreeChange[]; rejected: string[] }> {
  const raw = await gitOk(target, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], 2_000_000);
  const parsed = parsePorcelainZ(raw);
  const changes: WorktreeChange[] = [];
  for (const change of parsed.changes) {
    if (change.status === 'deleted') { changes.push(change); continue; }
    const info = await lstat(path.join(target.path, change.path)).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (info?.isSymbolicLink()) { parsed.rejected.push(change.path); continue; }
    changes.push(change);
  }
  return { changes, rejected: parsed.rejected };
}

export async function syncWorktreeClaims(ctx: Context, p: Project, missionId: string, input: unknown): Promise<Mission & { verdict: import('./mission.js').MissionVerdict; rejected: string[] }> {
  confirmed(input); trusted(p);
  const mission = owned<Mission>(ctx, 'missions', missionId, p.id);
  if (mission.status === 'cancelled') throw new AdvancedError(409, 'MISSION_CLOSED', 'Mission annulée.');
  const agents = ctx.store.all<{ id: string; projectId: string; worktreePath: string }>('agents', p.id).filter((agent) => agent.projectId === p.id);
  const rejected: string[] = [];
  const claims: FileClaim[] = [];
  for (const agent of agents) {
    const target = await safeWorktree(p, agent.worktreePath);
    const found = await changedPaths(target);
    rejected.push(...found.rejected);
    claims.push({ agentId: agent.id, paths: claimsFromChanges(agent.id, found.changes) });
  }
  mission.claims = claims.filter((claim) => claim.paths.length);
  mission.conflicts = detectClaimConflicts(mission.claims);
  const view = storeMission(ctx, mission);
  ctx.history(p.id, 'mission-claims', view.conflicts.length ? 'Conflits déduits des worktrees' : 'Revendications déduites des worktrees', `${view.conflicts.map((conflict) => conflict.path).join(', ') || 'aucun conflit'}; rejetés=${rejected.length}. Aucune fusion.`);
  return { ...view, rejected };
}

export function registerWorktreeClaimRoutes(app: Express, ctx: Context): void {
  app.post('/api/projects/:id/missions/:missionId/claims/sync', route(ctx, async (req, res) => {
    res.json(await syncWorktreeClaims(ctx, project(ctx, req), param(req, 'missionId'), req.body));
  }));
}
