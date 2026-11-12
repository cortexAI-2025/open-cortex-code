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
