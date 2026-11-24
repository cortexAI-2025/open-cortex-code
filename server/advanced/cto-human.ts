import type { Express } from 'express';
import { z } from 'zod';
import type { HumanDelegationView, HumanOverview, HumanStatusView } from '../../shared/contracts.js';
import { AdvancedError, type Context, confirmed, param, route } from './common.js';
import { cto } from './cto-bridge.js';

/**
 * Open Cortex side of the human loop: the owner reads the EXACT brief a Payworker would see, approves or rejects it (bound to its
 * hash), follows the mission and reviews the delivered result. Everything is forwarded to the CTO IA, which is the only MCP
 * client. Open Cortex holds no AIWORKPAY credential and has no route that validates a result or pays: that authority stays
 * with a human outside the CTO (D3).
 */
const briefSchema = z.object({
  type: z.enum(['physical_verification', 'photo', 'phone_call', 'data_collection', 'document_check', 'other']),
  title: z.string().trim().min(3).max(200), instructions: z.string().trim().min(10).max(4000),
  budget: z.number().positive().max(10_000), currency: z.string().regex(/^[A-Za-z]{3}$/u), deadline: z.string().max(40),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  location: z.object({ city: z.string().max(200).optional(), address: z.string().max(500).optional(), country: z.string().max(100).optional(), details: z.string().max(1000).optional() }).strict().optional(),
  deliverables: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
}).strict();
const createSchema = z.object({ brief: briefSchema, confirm: z.literal(true) }).strict();
const approvalSchema = z.object({ decision: z.enum(['approve', 'reject']), briefHash: z.string().regex(/^[a-f0-9]{64}$/u), note: z.string().trim().max(500).optional(), confirm: z.literal(true) }).strict();
const reviewSchema = z.object({ verdict: z.enum(['acceptable', 'needs_changes', 'rejected']), note: z.string().trim().max(1000).optional(), confirm: z.literal(true) }).strict();
const confirmSchema = z.object({ confirm: z.literal(true) }).strict();
const idOf = (req: Parameters<typeof param>[0]): string => {
  const value = param(req, 'delegationId');
  if (!/^[0-9a-f-]{36}$/iu.test(value)) throw new AdvancedError(400, 'VALIDATION', 'Identifiant de délégation invalide.');
  return value;
};

async function overview(ctx: Context): Promise<HumanOverview> {
  try {
    const status = await cto<HumanStatusView>(ctx, 'GET', '/api/human/status');
    if (!status.enabled) return { status, delegations: [] };
    return { status, delegations: await cto<HumanDelegationView[]>(ctx, 'GET', '/api/delegations') };
  } catch (error) {
    if ((error as { code?: string }).code === 'CTO_NOT_FOUND') return { status: { enabled: false, disabled_reasons: ['Délégation humaine non configurée côté CTO IA.'] }, delegations: [] };
    throw error;
  }
}

export function registerCtoHumanRoutes(app: Express, ctx: Context): void {
  app.get('/api/cto/human', route(ctx, async (_req, res) => { res.json(await overview(ctx)); }));

  app.post('/api/cto/human/delegations', route(ctx, async (req, res) => {
    confirmed(req.body);
    const input = createSchema.parse(req.body);
    res.status(201).json(await cto<HumanDelegationView>(ctx, 'POST', '/api/delegations', { brief: input.brief }));
  }));

  app.get('/api/cto/human/delegations/:delegationId', route(ctx, async (req, res) => {
    res.json(await cto<HumanDelegationView>(ctx, 'GET', `/api/delegations/${idOf(req)}`));
  }));

  app.post('/api/cto/human/delegations/:delegationId/approval', route(ctx, async (req, res) => {
    confirmed(req.body);
    const input = approvalSchema.parse(req.body);
    const id = idOf(req);
    // Fresh state first: the decision is only forwarded for the very brief the owner saw, still awaiting approval.
    const current = await cto<HumanDelegationView>(ctx, 'GET', `/api/delegations/${id}`);
    if (current.status !== 'awaiting_approval') throw new AdvancedError(409, 'NOT_AWAITING_APPROVAL', `Cette délégation est « ${current.status} » : plus d'approbation possible.`);
    if (current.brief_hash !== input.briefHash) throw new AdvancedError(409, 'BRIEF_CHANGED', 'Le brief a changé depuis son affichage : relisez-le avant de décider.');
    res.json(await cto<HumanDelegationView>(ctx, 'POST', `/api/delegations/${id}/approval`, { decision: input.decision, brief_hash: input.briefHash, note: `${input.note ?? ''} [via Open Cortex Code]`.trim() }));
  }));

  app.post('/api/cto/human/delegations/:delegationId/cancel', route(ctx, async (req, res) => {
    confirmed(req.body); confirmSchema.parse(req.body);
    res.json(await cto<HumanDelegationView>(ctx, 'POST', `/api/delegations/${idOf(req)}/cancel`, {}));
  }));

  app.post('/api/cto/human/delegations/:delegationId/refresh', route(ctx, async (req, res) => {
    confirmed(req.body); confirmSchema.parse(req.body);
    res.json(await cto<HumanDelegationView>(ctx, 'POST', `/api/delegations/${idOf(req)}/refresh`, {}));
  }));

  app.post('/api/cto/human/delegations/:delegationId/review', route(ctx, async (req, res) => {
    confirmed(req.body);
    const input = reviewSchema.parse(req.body);
    res.json(await cto<HumanDelegationView>(ctx, 'POST', `/api/delegations/${idOf(req)}/review`, { verdict: input.verdict, note: input.note }));
  }));
}
