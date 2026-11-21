/** Estimation locale (caractères / 4). Ce n’est pas une facture fournisseur. */
export const CHARS_PER_TOKEN = 4;
export const MAX_CONTEXT_BUDGET = 12_000;

export interface ContextItem {
  id: string;
  kind: 'instruction' | 'memory' | 'document' | 'recent' | 'evidence' | 'handoff';
  title: string;
  text: string;
}

export interface PackedContext {
  text: string;
  estimatedTokens: number;
  budget: number;
  included: { id: string; kind: ContextItem['kind']; estimatedTokens: number; truncated: boolean }[];
  omitted: { id: string; kind: ContextItem['kind']; reason: 'budget' | 'empty' }[];
  truncated: boolean;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function clampBudget(budgetTokens: number): number {
  if (!Number.isFinite(budgetTokens)) return 800;
  return Math.max(32, Math.min(Math.floor(budgetTokens), MAX_CONTEXT_BUDGET));
}

function render(item: ContextItem, text: string): string {
  return `[${item.kind}] ${item.title}\n${text}`;
}

/** Garde les instructions en tête, puis le reste dans l’ordre donné. Tronque au budget, n’invente rien. */
export function packContext(items: ContextItem[], budgetTokens: number): PackedContext {
  const budget = clampBudget(budgetTokens);
  const omitted: PackedContext['omitted'] = [];
  const included: PackedContext['included'] = [];
  const chunks: string[] = [];
  let used = 0;
  let truncated = false;
  const ordered = [
    ...items.filter((item) => item.kind === 'instruction'),
    ...items.filter((item) => item.kind !== 'instruction'),
  ];
  for (const item of ordered) {
    const body = item.text.trim();
    if (!body) { omitted.push({ id: item.id, kind: item.kind, reason: 'empty' }); continue; }
    const block = render(item, body);
    const cost = estimateTokens(block);
    const remaining = budget - used;
    if (cost <= remaining) {
      chunks.push(block);
      used += cost;
      included.push({ id: item.id, kind: item.kind, estimatedTokens: cost, truncated: false });
      continue;
    }
    if (included.length === 0 && remaining >= 24) {
      const slice = block.slice(0, remaining * CHARS_PER_TOKEN);
      const estimated = estimateTokens(slice);
      chunks.push(slice);
      used += estimated;
      included.push({ id: item.id, kind: item.kind, estimatedTokens: estimated, truncated: true });
    } else {
      omitted.push({ id: item.id, kind: item.kind, reason: 'budget' });
    }
    truncated = true;
  }
  return { text: chunks.join('\n\n'), estimatedTokens: used, budget, included, omitted, truncated };
}

export function modelHandoff(input: { goal: string; fromProfileId: string; toProfileId: string; pending: string[]; evidence: string }): string {
  return [
    'Transfert de contexte. Ne pas envoyer ce dossier à un nouveau fournisseur sans accord explicite (confirmProviderChange).',
    `Profil source: ${input.fromProfileId}`,
    `Profil cible: ${input.toProfileId || input.fromProfileId}`,
    `Objectif: ${input.goal}`,
    `Étapes restantes: ${input.pending.join(' | ') || 'aucune'}`,
    `Preuves: ${input.evidence || 'aucune'}`,
    'Ne pas déclarer la mission terminée sans un test local exit 0, non tronqué et sans timeout.',
  ].join('\n');
}
