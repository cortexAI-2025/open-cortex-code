import type { Express } from 'express';
import { z } from 'zod';
import type { Project } from '../../shared/contracts.js';
import { isSensitivePath } from '../security.js';
import { AdvancedError, type Context, confirmed, hash, id, now, owned, param, project, readSafe, redact, route, trusted, writeSafe } from './common.js';
import { normalizeClaimPath, type FileClaim } from './conflicts.js';
import { storeMission, type Mission, type RepairAttempt } from './mission.js';
import { runCommand } from './process.js';

const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|specs?)\/|(?:\.(?:test|spec))\.[A-Za-z0-9]+$/u;
export function isEvidencePath(file: string): boolean {
  return TEST_PATH.test(file);
}
const SKIP_MARK = /\.skip\b|\bxit\(|\bxdescribe\(|\bit\.skip\b|\btest\.skip\b|\bpytest\.skip\b|@pytest\.mark\.skip\b/g;
const TEST_CALL = /\b(?:it|test|describe)\(/g;
const RUNNER = /^(?:node|pnpm|npm|npx|vitest|jest|pytest|python3?|go|cargo|bun)(?:\s|$)/u;

export interface FailureDiagnosis { files: string[]; summary: string }

export function weakensTests(path: string, before: string, after: string): boolean {
  if (!TEST_PATH.test(path)) return false;
  if (!after.trim() && before.trim()) return true;
  const skips = (value: string) => value.match(SKIP_MARK)?.length ?? 0;
  const calls = (value: string) => value.match(TEST_CALL)?.length ?? 0;
  return skips(after) > skips(before) || calls(after) < calls(before);
}

export function pathInScope(file: string, claims: FileClaim[]): boolean {
  let target: string;
  try { target = normalizeClaimPath(file); } catch { return false; }
  return claims.some((claim) => claim.paths.some((raw) => {
    try {
      const ownedPath = normalizeClaimPath(raw);
      return target === ownedPath || target.startsWith(`${ownedPath}/`);
    } catch { return false; }
  }));
}

export function diagnoseFailure(output: string, projectPath = ''): FailureDiagnosis {
  const files = new Set<string>();
  const prefix = projectPath ? projectPath.replace(/\/+$/u, '') + '/' : '';
  const source = prefix ? output.split(prefix).slice(1).map((part) => part.split(/[\s"'`):]/u)[0] ?? '') : [];
  const relatives = source.concat([...output.matchAll(/(?:^|[\s("'"])((?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+\.[A-Za-z0-9]{1,8})(?::\d+(?::\d+)?)?/gm)].map((match) => match[1] ?? ''));
  for (const raw of relatives) {
    const clean = raw.replace(/:\d+(?::\d+)?$/u, '').replace(/^\.?\//u, '');
    if (!clean || clean.includes('node_modules') || clean.startsWith('/') || clean.includes('..')) continue;
    try { files.add(normalizeClaimPath(clean)); } catch { /* chemin non revendiquable */ }
  }
  const summary = output.trim().split('\n').filter(Boolean).slice(-12).join('\n').slice(0, 2_000);
  return { files: [...files].slice(0, 20), summary: summary || 'Aucune sortie de test.' };
}

export function assertRepairCommand(command: string): void {
  if (!RUNNER.test(command) || /(?:^|\s)(?:rm|git)(?:\s|$)|(?:^|\s)exit\s+0\s*$/u.test(command)) {
    throw new AdvancedError(400, 'REPAIR_COMMAND_DENIED', 'La commande de preuve doit être un lanceur de tests. exit 0, rm et git sont refusés.');
  }
}

export interface RepairPatch { path: string; before: string; after: string }
export interface RepairOptions { clock?: () => number; afterAttempt?: (index: number) => Promise<unknown> | unknown }

function attempt(partial: Omit<RepairAttempt, 'id' | 'createdAt'>): RepairAttempt {
  return { id: id(), createdAt: now(), ...partial };
}

export async function runRepairLoop(ctx: Context, p: Project, missionId: string, input: unknown, options: RepairOptions = {}): Promise<Mission & { verdict: import('./mission.js').MissionVerdict }> {
  confirmed(input); trusted(p);
  const body = z.object({
    command: z.string().trim().min(1).max(4_000),
    confirm: z.literal(true),
    maxAttempts: z.number().int().min(1).max(3).default(3),
    budgetMs: z.number().int().min(50).max(120_000).default(60_000),
    timeoutMs: z.number().int().min(50).max(30_000).default(15_000),
    patches: z.array(z.object({ path: z.string().min(1).max(500), before: z.string().min(1).max(20_000), after: z.string().max(20_000) }).strict()).max(3).default([]),
  }).strict().parse(input);
  assertRepairCommand(body.command);
  const clock = options.clock ?? Date.now;
  const started = clock();
  const mission = owned<Mission>(ctx, 'missions', missionId, p.id);
  if (mission.status === 'cancelled') throw new AdvancedError(409, 'MISSION_CLOSED', 'Mission annulée.');
  const repairs: RepairAttempt[] = [...(mission.repairs ?? [])];
  const evidence = [...mission.evidence];
  const queue = [...body.patches];
  let cancelled = false;
  const persist = () => {
    const fresh = owned<Mission>(ctx, 'missions', missionId, p.id);
    fresh.repairs = repairs;
    fresh.evidence = evidence;
    if (cancelled) fresh.status = 'cancelled';
    return storeMission(ctx, fresh);
  };
  for (let index = 1; index <= body.maxAttempts; index += 1) {
    if (clock() - started > body.budgetMs) {
      repairs.push(attempt({ index, exitCode: null, timedOut: false, truncated: false, files: [], diagnosis: 'Budget de temps dépassé avant une nouvelle tentative.', applied: [], rejected: [], stopped: 'budget' }));
      break;
    }
    const command = await runCommand(ctx, p, { command: body.command, confirm: true, kind: 'test', timeoutMs: body.timeoutMs });
    const statusNow = owned<Mission>(ctx, 'missions', missionId, p.id).status;
    evidence.push({ id: id(), commandId: command.id, command: command.command, exitCode: command.exitCode, timedOut: command.timedOut, truncated: command.truncated, createdAt: command.createdAt });
    const diagnosis = diagnoseFailure(command.output, p.path);
    const passed = command.exitCode === 0 && !command.timedOut && !command.truncated;
    if (statusNow === 'cancelled') {
      cancelled = true;
      repairs.push(attempt({ index, commandId: command.id, exitCode: command.exitCode, timedOut: command.timedOut, truncated: command.truncated, files: diagnosis.files, diagnosis: 'Annulé après le test. Aucun correctif appliqué.', applied: [], rejected: [], stopped: 'cancelled' }));
      break;
    }
    if (command.timedOut || command.truncated) {
      repairs.push(attempt({ index, commandId: command.id, exitCode: command.exitCode, timedOut: command.timedOut, truncated: command.truncated, files: diagnosis.files, diagnosis: redact(ctx, diagnosis.summary), applied: [], rejected: [], stopped: 'timeout' }));
      break;
    }
    if (passed) {
      repairs.push(attempt({ index, commandId: command.id, exitCode: 0, timedOut: false, truncated: false, files: diagnosis.files, diagnosis: 'Test exit 0.', applied: [], rejected: [], stopped: 'passed' }));
      break;
    }
    const patch = index < body.maxAttempts ? queue.shift() : undefined;
    const recordFailure = (stopped: RepairAttempt['stopped'], rejected: string[] = [], applied: string[] = []) => {
      repairs.push(attempt({ index, commandId: command.id, exitCode: command.exitCode, timedOut: false, truncated: false, files: diagnosis.files, diagnosis: redact(ctx, diagnosis.summary), applied, rejected, stopped }));
    };
    if (!patch) {
      recordFailure('no-fix', index >= body.maxAttempts ? queue.map((item) => item.path) : []);
      await options.afterAttempt?.(index);
      if (owned<Mission>(ctx, 'missions', missionId, p.id).status === 'cancelled') {
        cancelled = true;
        repairs.push(attempt({ index: index + 1, exitCode: null, timedOut: false, truncated: false, files: [], diagnosis: 'Annulé entre deux tentatives.', applied: [], rejected: [], stopped: 'cancelled' }));
        break;
      }
      if (index >= body.maxAttempts) break;
      continue;
    }
    let reason = '';
    try { normalizeClaimPath(patch.path); } catch { reason = 'path'; }
    if (!reason && isSensitivePath(patch.path)) reason = 'sensitive';
    else if (!reason && weakensTests(patch.path, patch.before, patch.after)) reason = 'test-tamper';
    else if (!reason && !pathInScope(patch.path, owned<Mission>(ctx, 'missions', missionId, p.id).claims)) reason = 'scope';
    else if (!reason && !diagnosis.files.includes(normalizeClaimPath(patch.path))) reason = 'unrelated';
    if (reason) {
      recordFailure(reason === 'test-tamper' ? 'test-tamper' : 'scope', [patch.path]);
      break;
    }
    const current = await readSafe(p, patch.path);
    const text = current?.toString('utf8') ?? '';
    if (!current || text.split(patch.before).length !== 2) {
      repairs.push(attempt({ index, commandId: command.id, exitCode: command.exitCode, timedOut: false, truncated: false, files: diagnosis.files, diagnosis: 'Correctif non applicable : fragment absent ou ambigu.', applied: [], rejected: [patch.path], stopped: 'no-fix' }));
      break;
    }
    await writeSafe(p, patch.path, Buffer.from(text.replace(patch.before, patch.after)), hash(current));
    repairs.push(attempt({ index, commandId: command.id, exitCode: command.exitCode, timedOut: false, truncated: false, files: diagnosis.files, diagnosis: redact(ctx, diagnosis.summary), applied: [normalizeClaimPath(patch.path)], rejected: [] }));
    ctx.history(p.id, 'repair', 'Correctif local appliqué', `${missionId} tentative ${index} : ${patch.path}. Aucun modèle appelé.`);
    await options.afterAttempt?.(index);
    if (owned<Mission>(ctx, 'missions', missionId, p.id).status === 'cancelled') {
      cancelled = true;
      repairs.push(attempt({ index: index + 1, exitCode: null, timedOut: false, truncated: false, files: [], diagnosis: 'Annulé après un correctif. Le fichier modifié reste sur le disque.', applied: [], rejected: [], stopped: 'cancelled' }));
      break;
    }
  }
  const view = persist();
  ctx.history(p.id, 'repair-loop', 'Boucle de correction terminée', `${view.id} tentatives=${view.repairs?.length ?? 0} verdict=${view.verdict.status}`);
  return view;
}

export function registerRepairRoutes(app: Express, ctx: Context): void {
  app.post('/api/projects/:id/missions/:missionId/repair', route(ctx, async (req, res) => {
    res.json(await runRepairLoop(ctx, project(ctx, req), param(req, 'missionId'), req.body));
  }));
}
