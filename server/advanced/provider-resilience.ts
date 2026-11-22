import { redact, type Context, now } from './common.js';

export type ProviderFailure = 'timeout' | 'rate-limit' | 'server' | 'auth' | 'other';
export interface ProviderBudget {
  id: string;
  projectId: string;
  providerId: string;
  maxLlmCalls: number;
  tokenBudget: number;
  callsUsed: number;
  tokensUsed: number;
  maxConcurrent: number;
  allowProviderSwitch: boolean;
  decisions: { at: string; code: string; allowed: boolean; reason: string }[];
}
export interface CircuitRecord {
  id: string;
  projectId: string;
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  openedAt?: string;
  cooldownMs: number;
  updatedAt: string;
}

const inflight = new Map<string, number>();

export function classifyProviderError(status: number | null, message: string): ProviderFailure {
  if (status === 429 || /too many requests|rate limit/i.test(message)) return 'rate-limit';
  if (status !== null && status >= 500) return 'server';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || /timeout|timed out|AbortError/i.test(message)) return 'timeout';
  return 'other';
}

export function tryEnter(providerId: string, max: number): boolean {
  const used = inflight.get(providerId) ?? 0;
  if (used >= max) return false;
  inflight.set(providerId, used + 1);
  return true;
}

export function leaveProvider(providerId: string): void {
  const used = inflight.get(providerId) ?? 0;
  if (used <= 1) inflight.delete(providerId);
  else inflight.set(providerId, used - 1);
}

function circuitOf(ctx: Context, providerId: string, projectId: string): CircuitRecord {
  return ctx.store.get<CircuitRecord>('circuits', providerId) ?? {
    id: providerId, projectId, state: 'closed', failures: 0, cooldownMs: 30_000, updatedAt: now(),
  };
}

export function guardModelCall(ctx: Context, missionId: string, providerId: string): { allowed: boolean; reason: string; code: string; tracked: boolean } {
  const budget = ctx.store.get<ProviderBudget>('provider-budgets', missionId);
  if (!budget) return { allowed: true, reason: 'Aucun budget explicite. Comportement antérieur conservé.', code: 'NO_BUDGET', tracked: false };
  const note = (code: string, allowed: boolean, reason: string) => {
    budget.decisions = [...(budget.decisions ?? []), { at: now(), code, allowed, reason: redact(ctx, reason).slice(0, 300) }].slice(-20);
    ctx.store.put('provider-budgets', budget, budget.projectId);
  };
  if (budget.providerId && budget.providerId !== providerId && !budget.allowProviderSwitch) {
    note('PROVIDER_SWITCH_DENIED', false, 'Changement de fournisseur refusé sans autorisation explicite.');
    return { allowed: false, reason: 'Changement de fournisseur refusé sans autorisation explicite.', code: 'PROVIDER_SWITCH_DENIED', tracked: false };
  }
  if (budget.callsUsed >= budget.maxLlmCalls || budget.tokensUsed >= budget.tokenBudget) {
    note('LLM_BUDGET', false, 'Budget d’appels ou de jetons atteint.');
    return { allowed: false, reason: 'Budget d’appels ou de jetons atteint. Aucun appel supplémentaire.', code: 'LLM_BUDGET', tracked: false };
  }
  const circuit = circuitOf(ctx, providerId, budget.projectId);
  const openFor = circuit.openedAt ? Date.now() - Date.parse(circuit.openedAt) : 0;
  if (circuit.state === 'open' && openFor < circuit.cooldownMs) {
    note('CIRCUIT_OPEN', false, 'Circuit ouvert après des erreurs fournisseur.');
    return { allowed: false, reason: 'Circuit ouvert. Nouvel appel fournisseur refusé jusqu’à refroidissement.', code: 'CIRCUIT_OPEN', tracked: false };
  }
  if (circuit.state === 'open') circuit.state = 'half-open';
  if (!tryEnter(providerId, Math.max(1, budget.maxConcurrent || 1))) {
    note('PROVIDER_CONCURRENCY', false, 'Concurrence fournisseur atteinte.');
    return { allowed: false, reason: 'Concurrence fournisseur atteinte.', code: 'PROVIDER_CONCURRENCY', tracked: false };
  }
  ctx.store.put('circuits', circuit, budget.projectId);
  note('ALLOW', true, `Appel ${providerId} admis.`);
  return { allowed: true, reason: 'Appel admis dans le budget.', code: 'ALLOW', tracked: true };
}

export function recordModelUse(ctx: Context, missionId: string, tokens?: { input: number; output: number }): void {
  const budget = ctx.store.get<ProviderBudget>('provider-budgets', missionId);
  if (!budget) return;
  budget.callsUsed += 1;
  budget.tokensUsed += (tokens?.input ?? 0) + (tokens?.output ?? 0);
  ctx.store.put('provider-budgets', budget, budget.projectId);
}

export function recordProviderSuccess(ctx: Context, providerId: string): void {
  const circuit = ctx.store.get<CircuitRecord>('circuits', providerId);
  if (!circuit) return;
  circuit.state = 'closed';
  circuit.failures = 0;
  circuit.openedAt = undefined;
  circuit.updatedAt = now();
  ctx.store.put('circuits', circuit, circuit.projectId);
}

export function observeProviderFailure(ctx: Context, providerId: string, projectId: string, status: number | null, message: string): ProviderFailure {
  const kind = classifyProviderError(status, message);
  const circuit = circuitOf(ctx, providerId, projectId);
  if (kind === 'rate-limit' || kind === 'server' || kind === 'timeout') {
    circuit.failures += 1;
    if (circuit.failures >= 3) {
      circuit.state = 'open';
      circuit.openedAt = now();
    }
  }
  circuit.updatedAt = now();
  ctx.store.put('circuits', circuit, projectId);
  return kind;
}
