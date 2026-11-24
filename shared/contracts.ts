export const ENGINE_VERSION = '2.2.7';
export type AgentMode = 'ask' | 'plan' | 'agent';
export interface Project { id: string; name: string; path: string; trusted: boolean; createdAt: string; updatedAt: string }
export interface Profile { id: string; name: string; providerId: string; modelId: string; baseUrl?: string; hasSecret: boolean; createdAt: string }
export interface CortexSession { id: string; projectId: string; title: string; mode: AgentMode; profileId: string; engineId?: string; status: 'idle' | 'running' | 'error' | 'permission'; createdAt: string; updatedAt: string }
export interface FileNode { name: string; path: string; type: 'file' | 'directory' }
export interface FileContent { path: string; content: string; hash: string }
export interface ChatMessage { id: string; role: 'user' | 'assistant' | 'system'; text: string; createdAt: string; tools?: ToolAction[]; tokens?: {input: number; output: number}; cost?: number; error?: string }
export interface ToolAction { id: string; name: string; status: string; input?: unknown; output?: string }
export interface PermissionRequest { id: string; sessionId: string; action: string; resources: string[]; description?: string }
export interface MemoryEntry { id: string; projectId: string; kind: 'decision' | 'instruction' | 'task' | 'error' | 'note'; title: string; content: string; updatedAt: string }
export interface KnowledgeDocument { id: string; projectId: string; name: string; content: string; createdAt: string }
export interface Skill { id: string; projectId: string; name: string; description: string; content: string; enabled?: boolean; createdAt: string }
export interface Automation { id: string; projectId: string; name: string; prompt: string; profileId: string; mode: AgentMode; schedule: 'manual' | 'daily' | 'weekly' | 'once'; time?: string; enabled: boolean; createdAt: string; nextRun?: string }
export interface HistoryEvent { id: string; projectId: string; kind: string; title: string; detail: string; createdAt: string }
export interface CommandResult { id: string; command: string; output: string; exitCode: number | null; durationMs: number; createdAt: string }
export interface Bootstrap { projects: Project[]; profiles: Profile[]; version: string; engineVersion: string; capabilities: Record<string, boolean> }
export interface ApiError { error: string; code?: string }

/** Équipe IA : CTO IA (agent superviseur) et ses quatre spécialistes. Aucun secret ne figure dans ces types. */
export type CtoSpecialistRole = 'architect' | 'backend' | 'qa' | 'security';
export type CtoConnection = 'connected' | 'unreachable' | 'unauthorized' | 'not_configured';
export interface CtoAgentInfo { role: CtoSpecialistRole; label: string; capabilities: string[]; readOnly: boolean; maxBudgetUsd: number | null; state: 'idle' | 'busy' | 'unknown'; runningTasks: Array<{ id: string; missionId: string }> }
export interface CtoRuntimeInfo { status: 'READY' | 'BLOCKED' | 'UNKNOWN'; blockers: string[]; isolation: string; containerCertified: false; checks: Array<{ name: string; ok: boolean; detail: string }>; repoPath?: string; checkedAt?: string }
export interface CtoTeam {
  supervisor: { id: 'cto-ia'; name: string; role: 'supervisor'; registered: boolean; registeredAt?: string; endpoint?: string; connection: CtoConnection; accessRole?: 'owner' | 'viewer'; lastSeenAt?: string; error?: { code: string; message: string } };
  runtime: CtoRuntimeInfo;
  agents: CtoAgentInfo[];
}
export type CtoLocalState = 'submitting' | 'linked' | 'cancelled';
export interface CtoTaskView { id: string; role: CtoSpecialistRole; status: string; attempts: number; corrections: number; failures: number; instruction: string }
export interface CtoReportView { id: string; role: CtoSpecialistRole; verdict: string; summary: string; problems: string[]; costUsd: number; costEstimated: boolean; tests?: { passed: number; failed: number }; branch?: string; commit?: string; createdAt: string }
export interface CtoEventView { id: string; type: string; actor: string; taskId?: string | null; detail: Record<string, unknown>; at: string }
export interface CtoMissionLink {
  id: string; projectId: string; repo: string; objective: string; acceptanceCriteria: string[]; scope: string[]; budgetUsd: number;
  localState: CtoLocalState; ctoMissionId?: string; status: string; pendingApprovals: string[]; blockers: string[];
  spentUsd: number; estimatedUsd: number; syncedAt?: string; stale?: boolean; lastError?: { code: string; message: string; at: string };
  createdAt: string; updatedAt: string;
}
export interface CtoMissionView {
  link: CtoMissionLink; tasks: CtoTaskView[]; reports: CtoReportView[]; events: CtoEventView[];
  report: null | {
    mission: Record<string, unknown>; costByRole: Record<string, number>; reviews: Array<{ role: string; verdict: string; findings: Array<{ severity: string; file: string; issue: string }>; blocking: boolean }>;
    tests: { passed: number; failed: number } | null; acceptanceTests: { passed: number; failed: number } | null;
    git: null | { branch: string; commit: string; baseCommit: string | null; files: string[]; diffstat: string; pushed: false; merged: false };
    pullRequestBody: string; corrections: number; reworkRounds: number;
  };
}

/** Délégation humaine (Payworker) pilotée par le CTO IA via le MCP AIWORKPAY. Le CTO ne peut ni valider ni payer. */
export type HumanDelegationStatus = 'awaiting_approval' | 'submitting' | 'awaiting_payment' | 'open' | 'assigned' | 'in_progress' | 'delivered' | 'completed' | 'rejected' | 'expired' | 'canceled' | 'blocked';
export interface HumanBrief { type: string; title: string; instructions: string; budget: number; currency: string; deadline: string; priority: string; location?: Record<string, string>; deliverables?: string[] }
export interface HumanFlag { code: string; where: string }
export interface HumanProofView { id: string; filename: string; mime_type: string; size_bytes: number | null; source: 'upload' | 'link'; virus_scan: string; stored: boolean; sha256: string | null; flags: HumanFlag[] }
export interface HumanResultView { delivered_at: string | null; validated: boolean; note: string; data: unknown; proofs: HumanProofView[]; flags: HumanFlag[]; risk: 'none' | 'low' | 'high'; ingested_at: string; content_warning: string }
export interface HumanDelegationView {
  id: string; mission_id: string | null; status: HumanDelegationStatus; brief: HumanBrief; brief_hash: string; reference: string;
  warnings: string[]; approval_expires_at: string; approval: null | { decision: string; by: string; at: string; note: string; brief_hash: string };
  ledger: null | { status: 'reserved' | 'committed' | 'released'; amount: number; currency: string; at: string };
  remote: null | { mission_id: string; already_existed: boolean; created_at: string };
  payment_url?: string | null; payment_url_expires_at?: string | null;
  last_error: null | { code: string; message: string; at: string }; result: HumanResultView | null;
  review: null | { verdict: 'acceptable' | 'needs_changes' | 'rejected'; note: string; by: string; at: string };
  created_at: string; updated_at: string;
}
export interface HumanStatusView {
  enabled: boolean; disabled_reasons: string[]; currency?: string; ceilings?: { max_per_delegation: number; monthly_budget: number; max_per_day: number };
  engaged?: { this_month: number; today: number }; remaining_this_month?: number; contract?: { ok: boolean | null; checked_at: string | null; problem: string | null };
  delegations?: Record<string, number>; authority?: string;
}
export interface HumanOverview { status: HumanStatusView; delegations: HumanDelegationView[] }
