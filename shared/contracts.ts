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
