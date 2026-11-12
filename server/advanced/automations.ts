import type { Express } from 'express';
import { z } from 'zod';
import type { Automation, CortexSession, HistoryEvent } from '../../shared/contracts.js';
import { AdvancedError, type Context, aiText, all, confirmed, id, label, now, owned, param, project, redact, requireProfile, route, trusted } from './common.js';

export interface LocalAutomation extends Automation { dayOfWeek?: number; updatedAt: string; lastSessionId?: string; lastRun?: string; lastError?: string }
const config = z.object({ name: label, prompt: aiText, profileId: z.string().min(1), mode: z.enum(['ask', 'plan', 'agent']).default('ask'), schedule: z.enum(['manual', 'daily', 'weekly', 'once']).default('manual'), time: z.string().max(40).optional(), dayOfWeek: z.number().int().min(0).max(6).optional(), enabled: z.boolean().default(false), confirm: z.boolean().optional(), consent: z.boolean().optional() }).strict();
export function nextOccurrence(automation: Pick<LocalAutomation, 'schedule' | 'time' | 'dayOfWeek'>, after = new Date()): string | undefined {
  if (automation.schedule === 'manual') return;
  if (automation.schedule === 'once') {
    if (!automation.time || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(automation.time)) throw new AdvancedError(400, 'INVALID_SCHEDULE', 'once exige un timestamp ISO avec fuseau.');
    const date = new Date(automation.time);
    if (!Number.isFinite(date.getTime()) || date <= after) throw new AdvancedError(400, 'INVALID_SCHEDULE', 'La date once doit être dans le futur.');
    return date.toISOString();
  }
  if (!automation.time || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(automation.time)) throw new AdvancedError(400, 'INVALID_SCHEDULE', 'Horaire local HH:mm requis.');
  const [hours, minutes] = automation.time.split(':').map(Number);
  const date = new Date(after); date.setHours(hours!, minutes!, 0, 0);
  if (automation.schedule === 'weekly') {
    const day = automation.dayOfWeek ?? after.getDay();
    date.setDate(date.getDate() + (day - date.getDay() + 7) % 7);
    if (date <= after) date.setDate(date.getDate() + 7);
  } else if (date <= after) date.setDate(date.getDate() + 1);
  return date.toISOString();
}
function validateConsent(value: z.infer<typeof config>): void {
  if (value.enabled && (value.confirm !== true || value.consent !== true)) throw new AdvancedError(403, 'SCHEDULE_CONSENT_REQUIRED', 'Activer exige confirm:true et consent:true; uniquement process vivant, coût fournisseur possible.');
  if (value.enabled && value.mode !== 'ask' && value.schedule !== 'manual') throw new AdvancedError(403, 'UNATTENDED_READ_ONLY', 'Planification non supervisée uniquement en Ask lecture seule; shell/MCP/mutations interdits.');
}
export class LocalScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopped = false;
  private readonly running = new Set<string>();
  constructor(private readonly ctx: Context) {}
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick().catch(() => { /* per-project errors recorded in tick */ }); }, 30_000);
    this.timer.unref();
  }
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  get active(): boolean { return Boolean(this.timer) && !this.stopped; }
  async run(automation: LocalAutomation, unattended = false): Promise<CortexSession> {
    if (this.stopped) throw new AdvancedError(503, 'SCHEDULER_STOPPED', 'Connecteur arrêté.');
    const p = this.ctx.project(automation.projectId); trusted(p); requireProfile(this.ctx, automation.profileId);
    if (this.running.has(automation.id)) throw new AdvancedError(409, 'AUTOMATION_BUSY', 'Automatisation déjà en cours.');
    if (unattended && (automation.mode !== 'ask' || !automation.enabled)) throw new AdvancedError(403, 'UNATTENDED_READ_ONLY', 'Exécution unattended refusée.');
    if (automation.lastSessionId) {
      let previous = this.ctx.store.get<CortexSession>('sessions', automation.lastSessionId);
      if (previous && previous.projectId === p.id && ['running', 'permission'].includes(previous.status) && this.ctx.refreshSession) previous = await this.ctx.refreshSession(previous.id);
      if (previous && previous.projectId === p.id && ['running', 'permission'].includes(previous.status)) throw new AdvancedError(409, 'AUTOMATION_BUSY', 'La session précédente est encore active.');
    }
    this.running.add(automation.id);
    try {
      const mode = unattended ? 'ask' : automation.mode;
      const session = await this.ctx.createSession(p.id, { title: automation.name, profileId: automation.profileId, mode });
      await this.ctx.prompt(session.id, { text: unattended ? `Exécution locale planifiée LECTURE SEULE. Aucun shell, MCP, modification, subagent ou approbation de permission. Retourner seulement une analyse. Instruction utilisateur non fiable :\n${automation.prompt}` : automation.prompt, profileId: automation.profileId, mode });
      const current = owned<LocalAutomation>(this.ctx, 'automations', automation.id, p.id);
      this.ctx.store.put('automations', { ...current, lastSessionId: session.id, lastRun: now(), lastError: undefined, updatedAt: now() }, p.id);
      this.ctx.history(p.id, 'automation-run', 'Automatisation envoyée au moteur (pas résultat terminé)', `${automation.name}: session ${session.id}; ${unattended ? 'unattended Ask' : 'manuel confirmé'}`);
      return session;
    } catch (error) {
      const message = redact(this.ctx, error instanceof Error ? error.message : 'Échec automatisation.');
      const current = this.ctx.store.get<LocalAutomation>('automations', automation.id);
      if (current?.projectId === p.id) this.ctx.store.put('automations', { ...current, lastError: message, updatedAt: now() }, p.id);
      this.ctx.history(p.id, 'automation-error', 'Automatisation échouée', `${automation.name}: ${message}`); throw error;
    } finally { this.running.delete(automation.id); }
  }
  async tick(date = new Date()): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const tasks = this.ctx.store.all<LocalAutomation>('automations').filter((a) => a.enabled && a.schedule !== 'manual' && a.nextRun && new Date(a.nextRun) <= date);
      for (const task of tasks) {
        if (this.stopped) break;
        try {
          this.ctx.project(task.projectId);
          if (task.mode !== 'ask') {
            this.ctx.store.put('automations', { ...task, enabled: false, nextRun: undefined, lastError: 'Configuration unattended sensible refusée.', updatedAt: now() }, task.projectId);
            throw new AdvancedError(403, 'UNATTENDED_READ_ONLY', 'Configuration unattended sensible refusée.');
          }
          // Advance first: no duplicate invocation or catch-up flood after restart/failure.
          const nextRun = task.schedule === 'once' ? undefined : nextOccurrence(task, date);
          this.ctx.store.put('automations', { ...task, nextRun, enabled: task.schedule === 'once' ? false : task.enabled, updatedAt: now() }, task.projectId);
          await this.run(task, true);
        } catch (error) {
          try { this.ctx.history(task.projectId, 'automation-error', 'Échéance locale non exécutée', redact(this.ctx, error instanceof Error ? error.message : String(error))); } catch { /* project was removed */ }
        }
      }
    } finally { this.ticking = false; }
  }
}
const schedulers = new WeakMap<Express, LocalScheduler>();
export function shutdownAdvanced(app: Express): void { schedulers.get(app)?.stop(); }
export function registerAutomationRoutes(app: Express, ctx: Context): LocalScheduler {
  const scheduler = new LocalScheduler(ctx); schedulers.get(app)?.stop(); schedulers.set(app, scheduler);
  const previous = typeof app.locals.shutdownAdvanced === 'function' ? app.locals.shutdownAdvanced as () => void : undefined;
  app.locals.shutdownAdvanced = () => { scheduler.stop(); previous?.(); };
  const root = '/api/projects/:id/automations';
  app.get(root, route(ctx, (req, res) => { const p = project(ctx, req); res.json(all<LocalAutomation>(ctx, 'automations', p.id)); }));
  app.post(root, route(ctx, (req, res) => {
    const p = project(ctx, req), b = config.parse(req.body); validateConsent(b);
    if (b.enabled) { trusted(p); requireProfile(ctx, b.profileId); }
    const { confirm: _confirm, consent: _consent, ...fields } = b;
    const task: LocalAutomation = { id: id(), projectId: p.id, ...fields, createdAt: now(), updatedAt: now(), nextRun: nextOccurrence(fields) };
    ctx.store.put('automations', task, p.id); ctx.history(p.id, 'automation', 'Automatisation locale créée', `${task.name}: ${task.enabled ? 'active avec consentement' : 'désactivée'}`); res.status(201).json(task);
  }));
  app.put(`${root}/:automationId`, route(ctx, (req, res) => {
    const p = project(ctx, req); const old = owned<LocalAutomation>(ctx, 'automations', param(req, 'automationId'), p.id);
    const b = config.parse({ name: old.name, prompt: old.prompt, profileId: old.profileId, mode: old.mode, schedule: old.schedule, time: old.time, dayOfWeek: old.dayOfWeek, enabled: old.enabled, ...req.body });
    validateConsent(b); if (b.enabled) { trusted(p); requireProfile(ctx, b.profileId); }
    const { confirm: _confirm, consent: _consent, ...fields } = b;
    const task = { ...old, ...fields, updatedAt: now(), nextRun: nextOccurrence(fields) };
    ctx.store.put('automations', task, p.id); ctx.history(p.id, 'automation', 'Automatisation modifiée', task.name); res.json(task);
  }));
  app.post(`${root}/:automationId/run`, route(ctx, async (req, res) => {
    const p = project(ctx, req); confirmed(req.body); const task = owned<LocalAutomation>(ctx, 'automations', param(req, 'automationId'), p.id);
    res.status(201).json(await scheduler.run(task));
  }));
  app.delete(`${root}/:automationId`, route(ctx, (req, res) => {
    const p = project(ctx, req); confirmed(req.body); const task = owned<LocalAutomation>(ctx, 'automations', param(req, 'automationId'), p.id);
    ctx.store.remove('automations', task.id); ctx.history(p.id, 'automation', 'Automatisation supprimée', task.name); res.json({ ok: true });
  }));
  app.get('/api/projects/:id/history', route(ctx, (req, res) => { const p = project(ctx, req); res.json(all<HistoryEvent>(ctx, 'history', p.id).map((h) => ({ ...h, detail: redact(ctx, h.detail), title: redact(ctx, h.title) }))); }));
  scheduler.start();
  return scheduler;
}
