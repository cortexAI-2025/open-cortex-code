import { relativePath } from './common.js';

export interface FileClaim { agentId: string; paths: string[] }
export interface PathConflict { path: string; agents: string[] }

export function normalizeClaimPath(value: string): string {
  return relativePath(value).replace(/\/+$/u, '');
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** Deux agents ne peuvent pas revendiquer le même fichier ni un dossier qui le contient. */
export function detectClaimConflicts(claims: FileClaim[]): PathConflict[] {
  const owned = new Map<string, Set<string>>();
  for (const claim of claims) {
    const agent = claim.agentId.trim();
    if (!agent) continue;
    for (const raw of claim.paths) {
      const file = normalizeClaimPath(raw);
      let agents = owned.get(file);
      if (!agents) { agents = new Set(); owned.set(file, agents); }
      agents.add(agent);
    }
  }
  const paths = [...owned.keys()];
  const conflicts: PathConflict[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const agents = new Set(owned.get(path));
    for (const other of paths) {
      if (other === path || !overlaps(path, other)) continue;
      for (const agent of owned.get(other) ?? []) agents.add(agent);
    }
    if (agents.size < 2) continue;
    const key = `${path}\0${[...agents].sort().join('\0')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    conflicts.push({ path, agents: [...agents].sort() });
  }
  return conflicts.sort((a, b) => a.path.localeCompare(b.path));
}
