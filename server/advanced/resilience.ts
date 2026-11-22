import type { Express } from 'express';
import { z } from 'zod';
import { AdvancedError, type Context, all, confirmed, id, now, param, project, route, trusted } from './common.js';
import type { Project } from '../../shared/contracts.js';

export type LeaseStatus = 'held' | 'released' | 'expired' | 'abandoned' | 'cancelled';
export interface LeaseRecord {
  id: string;
  projectId: string;
  missionId: string;
  taskKey: string;
  owner: string;
  idempotencyKey: string;
  status: LeaseStatus;
  heartbeatAt: string;
  expiresAt: string;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
  checkpoint: 'pending' | 'passed' | 'failed';
  invalidated: boolean;
  exactlyOnce: false;
  externalState: 'none' | 'started' | 'acked' | 'unknown';
  updatedAt: string;
}

const stamp = (clock?: () => number) => new Date(clock ? clock() : Date.now()).toISOString();

export function claimRerun(checkpoint: LeaseRecord['checkpoint'], invalidated: boolean): { run: boolean; code: 'RUN' | 'ALREADY_PASSED' } {
  if (checkpoint === 'passed' && !invalidated) return { run: false, code: 'ALREADY_PASSED' };
  return { run: true, code: 'RUN' };
}

export function acquireLease(ctx: Context, input: { projectId: string; missionId: string; taskKey: string; ttlMs: number; maxAttempts?: number; backoffMs?: number; idempotencyKey?: string; invalidated?: boolean }, clock: () => number = Date.now): { ok: true; lease: LeaseRecord; duplicate: boolean } | { ok: false; code: string; lease?: LeaseRecord } {
  const key = `${input.projectId}:${input.missionId}:${input.taskKey}`;
  const existing = ctx.store.get<LeaseRecord>('leases', key);
  const at = clock();
  if (existing && existing.projectId === input.projectId) {
    if (existing.idempotencyKey === (input.idempotencyKey || key) && existing.externalState === 'unknown') {
      return { ok: false, code: 'EXTERNAL_UNCERTAIN', lease: existing };
    }
    if (existing.idempotencyKey === (input.idempotencyKey || key) && existing.externalState === 'acked') {
      return { ok: true, lease: { ...existing, exactlyOnce: false }, duplicate: true };
    }
    const rerun = claimRerun(existing.checkpoint, input.invalidated === true);
    if (!rerun.run && existing.status === 'released') return { ok: false, code: 'ALREADY_PASSED', lease: existing };
    const expiry = Date.parse(existing.expiresAt);
    if (existing.status === 'held' && expiry > at) return { ok: false, code: 'EXECUTION_BUSY', lease: existing };
    if (existing.status === 'held' && expiry <= at) existing.status = 'abandoned';
  }
  const lease: LeaseRecord = {
    id: key, projectId: input.projectId, missionId: input.missionId, taskKey: input.taskKey,
    owner: id(), idempotencyKey: input.idempotencyKey || key, status: 'held',
    heartbeatAt: stamp(clock), expiresAt: new Date(at + input.ttlMs).toISOString(),
    attempts: (existing?.attempts ?? 0) + 1, maxAttempts: input.maxAttempts ?? 3, backoffMs: input.backoffMs ?? 400,
    checkpoint: 'pending', invalidated: input.invalidated === true, exactlyOnce: false, externalState: 'none', updatedAt: stamp(clock),
  };
  if (lease.attempts > lease.maxAttempts) return { ok: false, code: 'RETRY_EXHAUSTED', lease };
  return { ok: true, lease: ctx.store.put('leases', lease, input.projectId), duplicate: false };
}

export function heartbeatLease(ctx: Context, projectId: string, leaseId: string, ttlMs: number, clock: () => number = Date.now): LeaseRecord {
  const lease = ctx.store.get<LeaseRecord>('leases', leaseId);
  if (!lease || lease.projectId !== projectId || lease.status !== 'held') throw new AdvancedError(409, 'LEASE_ABSENT', 'Bail introuvable ou déjà clos.');
  const at = clock();
  lease.heartbeatAt = stamp(clock);
  lease.expiresAt = new Date(at + ttlMs).toISOString();
  lease.updatedAt = lease.heartbeatAt;
  return ctx.store.put('leases', lease, projectId);
}

export function finishLease(ctx: Context, projectId: string, leaseId: string, checkpoint: LeaseRecord['checkpoint'], clock: () => number = Date.now): LeaseRecord {
  const lease = ctx.store.get<LeaseRecord>('leases', leaseId);
  if (!lease || lease.projectId !== projectId) throw new AdvancedError(404, 'LEASE_ABSENT', 'Bail introuvable.');
  lease.status = 'released';
  lease.checkpoint = checkpoint;
  lease.updatedAt = stamp(clock);
  return ctx.store.put('leases', lease, projectId);
}

export function detectAbandoned(ctx: Context, projectId: string, clock: () => number = Date.now): LeaseRecord[] {
  const at = clock();
  return all<LeaseRecord>(ctx, 'leases', projectId).map((lease) => {
    if (lease.status === 'held' && Date.parse(lease.expiresAt) <= at) {
      lease.status = 'abandoned';
      lease.updatedAt = stamp(clock);
      return ctx.store.put('leases', lease, projectId);
    }
    return lease;
  }).filter((lease) => lease.status === 'abandoned');
}

export function beginExternal(ctx: Context, projectId: string, idempotencyKey: string, effect: () => void): { duplicate: boolean; exactlyOnce: false; state: LeaseRecord['externalState'] } {
  const existing = all<LeaseRecord>(ctx, 'leases', projectId).find((lease) => lease.idempotencyKey === idempotencyKey);
  if (existing && (existing.externalState === 'acked' || existing.externalState === 'unknown' || existing.externalState === 'started')) {
    return { duplicate: true, exactlyOnce: false, state: existing.externalState };
  }
  const lease: LeaseRecord = existing ?? {
    id: `ext:${idempotencyKey}`, projectId, missionId: 'external', taskKey: 'external', owner: id(), idempotencyKey,
    status: 'held', heartbeatAt: now(), expiresAt: new Date(Date.now() + 60_000).toISOString(), attempts: 1, maxAttempts: 3, backoffMs: 400,
    checkpoint: 'pending', invalidated: false, exactlyOnce: false, externalState: 'started', updatedAt: now(),
  };
  lease.externalState = 'started';
  lease.exactlyOnce = false;
  ctx.store.put('leases', lease, projectId);
  try {
    effect();
    lease.externalState = 'acked';
  } catch {
    lease.externalState = 'unknown';
    ctx.store.put('leases', lease, projectId);
    return { duplicate: false, exactlyOnce: false, state: 'unknown' };
  }
  ctx.store.put('leases', lease, projectId);
  return { duplicate: false, exactlyOnce: false, state: 'acked' };
}

export function retryDelay(attempt: number, kind: string, maxRetries: number, backoffMs: number): { retry: boolean; waitMs: number; reason: string } {
  if (kind === 'auth' || kind === 'policy' || kind === 'client') return { retry: false, waitMs: 0, reason: 'Erreur non rejouée.' };
  if (attempt >= maxRetries) return { retry: false, waitMs: 0, reason: 'Retries épuisés.' };
  return { retry: true, waitMs: Math.min(backoffMs * 2 ** Math.max(0, attempt - 1), 30_000), reason: 'Retry borné.' };
}

const beatSchema = z.object({ confirm: z.literal(true), leaseId: z.string().min(1).max(300), ttlMs: z.number().int().min(500).max(120_000).optional() }).strict();

export function registerResilienceRoutes(app: Express, ctx: Context): void {
  app.get('/api/projects/:id/resilience', route(ctx, (req, res) => {
    const target = project(ctx, req);
    res.json({ leases: all<LeaseRecord>(ctx, 'leases', target.id), abandoned: detectAbandoned(ctx, target.id) });
  }));
  app.post('/api/projects/:id/missions/:missionId/lease/heartbeat', route(ctx, (req, res) => {
    const target: Project = project(ctx, req);
    trusted(target);
    const body = beatSchema.parse({ ...req.body, confirm: req.body?.confirm });
    confirmed(body);
    res.json(heartbeatLease(ctx, target.id, body.leaseId, body.ttlMs ?? 15_000));
  }));
  app.post('/api/projects/:id/missions/:missionId/lease/cancel', route(ctx, (req, res) => {
    const target = project(ctx, req);
    trusted(target);
    confirmed(req.body);
    const leaseId = z.object({ leaseId: z.string().min(1).max(300), confirm: z.literal(true) }).strict().parse(req.body).leaseId;
    const lease = ctx.store.get<LeaseRecord>('leases', leaseId);
    if (!lease || lease.projectId !== target.id || lease.missionId !== param(req, 'missionId')) throw new AdvancedError(404, 'LEASE_ABSENT', 'Bail introuvable.');
    lease.status = 'cancelled';
    lease.updatedAt = now();
    res.json(ctx.store.put('leases', lease, target.id));
  }));
}
