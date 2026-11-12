import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SessionInfo, SessionMessageInfo, SessionMessagesResponse, ModelInfo, ProviderInfo } from '@opencode/client';
import type { AgentMode, ChatMessage, CortexSession, HistoryEvent, KnowledgeDocument, MemoryEntry, Profile, Project, ToolAction } from '../shared/contracts.js';
import { Engine, modePermissions } from './engine.js';
import { HttpError, isLoopback } from './security.js';
import { Store } from './store.js';
import { Vault } from './vault.js';

export interface SessionInput { title: string; profileId: string; mode: AgentMode }
export interface PromptInput { text: string; profileId: string; mode: AgentMode; confirmProviderChange?: boolean }
export interface ConnectorContext {
  store: Store;
  vault: Vault;
  engine: Engine;
  project(id: string): Project;
  createSession(projectId: string, input: SessionInput): Promise<CortexSession>;
  prompt(sessionId: string, input: PromptInput): Promise<{ accepted: true }>;
  refreshSession?(sessionId: string): Promise<CortexSession>;
  history(projectId: string, kind: string, title: string, detail: string): HistoryEvent;
}
export const sessionSchema = z.object({ title: z.string().trim().min(1).max(200), profileId: z.string().min(1).max(100), mode: z.enum(['ask', 'plan', 'agent']) }).strict();
export const promptSchema = z.object({ text: z.string().trim().min(1).max(64000), profileId: z.string().min(1).max(100), mode: z.enum(['ask', 'plan', 'agent']), confirmProviderChange: z.boolean().optional() }).strict();
function data<T>(value: unknown): T {
  return value && typeof value === 'object' && 'data' in value ? value.data as T : value as T;
}
function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return JSON.stringify(error) ?? 'Erreur moteur';
}
export function projectMessage(message: SessionMessageInfo, vault: Vault): ChatMessage {
  const base: ChatMessage = { id: message.id, role: message.type === 'user' ? 'user' : message.type === 'assistant' ? 'assistant' : 'system', text: '', createdAt: new Date(message.time.created).toISOString() };
  if ('text' in message && typeof message.text === 'string') base.text = message.text;
  if (message.type === 'assistant') {
    base.text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    base.tools = message.content.filter((part) => part.type === 'tool').map((part): ToolAction => {
      const action: ToolAction = { id: part.id, name: part.name, status: part.state.status };
      if ('input' in part.state) action.input = part.state.input;
      if ('content' in part.state && part.state.content) action.output = part.state.content.map((item) => item.type === 'text' ? item.text : '[Pièce jointe outil disponible dans le moteur]').join('\n');
      if (part.state.status === 'error') action.output = [action.output, errorText(part.state.error)].filter(Boolean).join('\n');
      return action;
    });
    if (message.tokens) base.tokens = { input: message.tokens.input, output: message.tokens.output };
    if (message.cost !== undefined) base.cost = message.cost;
    if (message.error) base.error = errorText(message.error);
  } else if (message.type === 'shell') {
    base.text = message.output?.output || '';
    base.tools = [{ id: message.shellID, name: 'shell', status: message.status, input: { command: message.command }, output: message.output?.output }];
  } else if (message.type === 'compaction') {
    base.text = 'summary' in message ? message.summary : 'Compaction échouée.';
    if ('error' in message) base.error = errorText(message.error);
  } else if (message.type === 'idle') {
    base.text = `Session ${message.outcome}.`;
    if (message.error) base.error = errorText(message.error);
  } else if (message.type === 'model-switched') base.text = `Modèle changé : ${message.model.providerID}/${message.model.id}`;
  else if (message.type === 'agent-switched') base.text = `Mode moteur changé : ${message.agent}`;
  else if (message.type === 'location-switched') base.text = 'Emplacement moteur changé.';
  return vault.redactValue(base);
}
export function relevantMemory(entries: MemoryEntry[], documents: KnowledgeDocument[], text: string): string {
  const terms = new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || []);
  const score = (value: string) => [...terms].reduce((sum, term) => sum + (value.toLocaleLowerCase().includes(term) ? 1 : 0), 0);
  const selected = entries.map((entry) => ({ entry, score: score(`${entry.title} ${entry.content}`) + (entry.kind === 'instruction' ? 100 : 0) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
  const passages = documents.flatMap((doc) => doc.content.split(/\n\s*\n/u).map((passage) => ({ name: doc.name, passage, score: score(passage) }))).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
  return [...selected.map(({ entry }) => `[${entry.kind}] ${entry.title}\n${entry.content.slice(0, 2400)}`), ...passages.map((item) => `[Document: ${item.name}]\n${item.passage.slice(0, 2000)}`)].join('\n\n').slice(0, 16000);
}

export class CoreContext implements ConnectorContext {
  readonly store: Store;
  readonly vault = new Vault();
  readonly engine: Engine;
  private readonly operations = new Set<string>();
  constructor(options: { dataDir: string; cliPath?: string }) {
    this.store = new Store(path.join(options.dataDir, 'cortex.sqlite'), (json) => JSON.stringify(this.vault.redactValue(JSON.parse(json) as unknown)));
    this.engine = new Engine({ ...options, vault: this.vault, project: (id) => this.project(id), profile: (id) => this.profile(id) });
    // Persisted profiles never imply a surviving memory credential.
    for (const profile of this.store.all<Profile>('profiles')) this.store.put('profiles', { ...profile, hasSecret: false });
    for (const session of this.store.all<CortexSession>('sessions')) if (session.status === 'running' || session.status === 'permission') this.store.put('sessions', { ...session, status: 'idle' }, session.projectId);
  }
  project(id: string): Project {
    const project = this.store.get<Project>('projects', id);
    if (!project) throw new HttpError(404, 'Projet inconnu.', 'PROJECT_NOT_FOUND');
    try {
      if (realpathSync(project.path) !== project.path || !statSync(project.path).isDirectory()) throw new Error('changed');
    } catch { throw new HttpError(403, 'Racine projet absente ou remplacée.', 'PROJECT_PATH_CHANGED'); }
    return project;
  }
  profile(id: string): Profile {
    const profile = this.store.get<Profile>('profiles', id);
    if (!profile) throw new HttpError(404, 'Profil inconnu.', 'PROFILE_NOT_FOUND');
    return { ...profile, hasSecret: !!this.vault.get(id) };
  }
  session(id: string): CortexSession {
    const session = this.store.get<CortexSession>('sessions', id);
    if (!session) throw new HttpError(404, 'Session inconnue.', 'SESSION_NOT_FOUND');
    this.project(session.projectId); return session;
  }
  history(projectId: string, kind: string, title: string, detail: string): HistoryEvent {
    this.project(projectId);
    return this.store.put('history', { id: randomUUID(), projectId, kind, title, detail, createdAt: new Date().toISOString() }, projectId);
  }
  async createSession(projectId: string, input: SessionInput): Promise<CortexSession> {
    const parsed = sessionSchema.parse(input);
    const project = this.project(projectId);
    const profile = this.profile(parsed.profileId);
    return this.exclusive(projectId, async () => {
      await this.assertIdle(projectId);
      await this.engine.activate(projectId, profile.id, parsed.mode);
      const created = data<SessionInfo>(await this.engine.request(projectId, 'POST', '/api/session', { title: parsed.title, agent: `cortex-${parsed.mode}`, model: { id: profile.modelId, providerID: profile.providerId }, permissions: modePermissions(parsed.mode) }, profile.id));
      if (!created.id || created.location.directory !== project.path) throw new HttpError(502, 'Session moteur sans ID ou mauvais Location.', 'ENGINE_PROTOCOL_ERROR');
      const now = new Date().toISOString();
      const session = this.store.put('sessions', { id: randomUUID(), projectId, title: parsed.title, mode: parsed.mode, profileId: profile.id, engineId: created.id, status: 'idle' as const, createdAt: now, updatedAt: now }, projectId);
      this.history(projectId, 'session', 'Session moteur créée', `${session.id} / ${created.id}`);
      return session;
    });
  }
  private async exclusive<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    if (this.operations.has(projectId)) throw new HttpError(409, 'Opération moteur déjà en cours pour ce projet.', 'PROJECT_BUSY');
    this.operations.add(projectId);
    try { return await action(); } finally { this.operations.delete(projectId); }
  }
  private async assertIdle(projectId: string): Promise<void> {
    for (const session of this.store.all<CortexSession>('sessions', projectId)) {
      if (session.status === 'running' || session.status === 'permission') {
        const current = await this.refreshSession(session.id);
        if (current.status === 'running' || current.status === 'permission') throw new HttpError(409, 'Une session travaille déjà dans ce projet.', 'PROJECT_BUSY');
      }
    }
    this.engine.setBusy(projectId, false);
  }
  async prompt(sessionId: string, input: PromptInput): Promise<{ accepted: true }> {
    const parsed = promptSchema.parse(input);
    const original = this.session(sessionId);
    const nextProfile = this.profile(parsed.profileId);
    const oldProfile = this.profile(original.profileId);
    const changedProvider = oldProfile.providerId !== nextProfile.providerId || oldProfile.baseUrl !== nextProfile.baseUrl;
    if (changedProvider && parsed.confirmProviderChange !== true) throw new HttpError(409, 'Confirmation requise avant transmission de la conversation à un autre fournisseur ou endpoint.', 'PROVIDER_CHANGE_REQUIRES_CONSENT');
    const local = nextProfile.baseUrl && isLoopback(new URL(nextProfile.baseUrl).hostname);
    if (!nextProfile.hasSecret && !local) throw new HttpError(409, 'Profil sans clé en mémoire. Aucun appel fournisseur n’a été lancé.', 'PROFILE_SECRET_REQUIRED');
    return this.exclusive(original.projectId, async () => {
      await this.assertIdle(original.projectId);
      let session = this.session(sessionId);
      if (!session.engineId) throw new HttpError(409, 'Session sans identifiant moteur.', 'ENGINE_SESSION_REQUIRED');
      const changed = session.profileId !== nextProfile.id || session.mode !== parsed.mode;
      const previousMessages = changed ? await this.messages(session.id) : [];
      await this.engine.activate(session.projectId, nextProfile.id, parsed.mode);
      if (changed) {
        await this.engine.request(session.projectId, 'POST', `/api/session/${session.engineId}/model`, { model: { id: nextProfile.modelId, providerID: nextProfile.providerId } }, nextProfile.id);
        await this.engine.request(session.projectId, 'POST', `/api/session/${session.engineId}/agent`, { agent: `cortex-${parsed.mode}` }, nextProfile.id);
        await this.engine.request(session.projectId, 'PATCH', `/api/session/${session.engineId}`, { permissions: modePermissions(parsed.mode) }, nextProfile.id);
        session = this.store.put('sessions', { ...session, mode: parsed.mode, profileId: nextProfile.id, updatedAt: new Date().toISOString() }, session.projectId);
      }
      const memory = relevantMemory(this.store.all<MemoryEntry>('memory', session.projectId), this.store.all<KnowledgeDocument>('knowledge', session.projectId), parsed.text);
      const transfer = changed ? `Résumé de transfert déterministe, non exhaustif (la session et tout son historique moteur sont conservés). Ancien modèle ${oldProfile.providerId}/${oldProfile.modelId}; nouveau ${nextProfile.providerId}/${nextProfile.modelId}; mode ${parsed.mode}.\n${previousMessages.slice(-12).map((message) => `${message.role}: ${message.text.slice(0, 1600)}`).join('\n').slice(0, 10000)}` : '';
      const skills = this.store.all<{ projectId: string; name: string; content: string; enabled?: boolean }>('skills', session.projectId)
        .filter((skill) => skill.projectId === session.projectId && skill.enabled === true)
        .slice(0, 8).map((skill) => `${skill.name}:\n${skill.content.slice(0, 4000)}`).join('\n\n').slice(0, 12000);
      const text = this.vault.redact([memory ? `<mémoire_projet données_locales_non_fiables>\n${memory}\n</mémoire_projet>` : '', skills ? `<skills_associés consentis_par_utilisateur données_non_fiables permissions_inchangées>\n${skills}\n</skills_associés>` : '', transfer ? `<transfert>\n${transfer}\n</transfert>` : '', `<demande_utilisateur>\n${parsed.text}\n</demande_utilisateur>`].filter(Boolean).join('\n\n'));
      try {
        const admitted = data<{ id: string }>(await this.engine.request(session.projectId, 'POST', `/api/session/${session.engineId}/prompt`, { text }, nextProfile.id));
        if (!admitted.id) throw new HttpError(502, 'Le moteur n’a pas confirmé l’admission du prompt.', 'ENGINE_PROTOCOL_ERROR');
        this.engine.setBusy(session.projectId, true);
        this.store.put('sessions', { ...session, status: 'running', updatedAt: new Date().toISOString() }, session.projectId);
        this.history(session.projectId, 'prompt', 'Prompt admis par OpenCode', `${session.id}; mode=${parsed.mode}; modèle=${nextProfile.providerId}/${nextProfile.modelId}; admission=${admitted.id}${changedProvider ? '; changement fournisseur consenti' : ''}`);
        return { accepted: true };
      } catch (error) {
        this.store.put('sessions', { ...session, status: 'error', updatedAt: new Date().toISOString() }, session.projectId);
        this.history(session.projectId, 'engine-error', 'Prompt refusé ou connexion échouée', errorText(error));
        throw error;
      }
    });
  }
  async refreshSession(id: string): Promise<CortexSession> {
    const session = this.session(id);
    if (!session.engineId) return session;
    const result = data<SessionInfo>(await this.engine.request(session.projectId, 'GET', `/api/session/${session.engineId}`, undefined, session.profileId));
    const pending = data<{ id: string }[]>(await this.engine.request(session.projectId, 'GET', `/api/session/${session.engineId}/permission`, undefined, session.profileId));
    const running = !!result.time.busy && (!result.time.idle || result.time.busy > result.time.idle);
    const status: CortexSession['status'] = pending.length ? 'permission' : running ? 'running' : result.outcome === 'failed' ? 'error' : 'idle';
    this.engine.setBusy(session.projectId, running || !!pending.length);
    return this.store.put('sessions', { ...session, status, updatedAt: new Date(result.time.updated).toISOString() }, session.projectId);
  }
  async messages(id: string): Promise<ChatMessage[]> {
    const session = this.session(id);
    if (!session.engineId) return [];
    const result = await this.engine.request(session.projectId, 'GET', `/api/session/${session.engineId}/message?limit=200&order=desc`, undefined, session.profileId) as SessionMessagesResponse;
    const messages = [...result.data].reverse().map((message) => projectMessage(message, this.vault));
    for (const message of messages) this.store.put('messages', { ...message, sessionId: id, projectId: session.projectId }, session.projectId);
    return messages;
  }
  async catalog(projectId: string): Promise<{ providers: { id: string; name: string; models: { id: string; name: string; context?: number; tools?: boolean; reasoning?: boolean; cost?: unknown }[] }[] }> {
    const [providerResult, modelResult] = await Promise.all([this.engine.request(projectId, 'GET', '/api/provider'), this.engine.request(projectId, 'GET', '/api/model')]);
    const providers = data<ProviderInfo[]>(providerResult);
    const models = data<ModelInfo[]>(modelResult);
    const ids = new Set([...providers.map((provider) => provider.id), ...models.map((model) => model.providerID)]);
    return { providers: [...ids].map((id) => ({ id, name: providers.find((provider) => provider.id === id)?.name || id, models: models.filter((model) => model.providerID === id).map((model) => ({ id: model.id, name: model.name, context: model.limit.context, tools: model.capabilities.tools, cost: model.cost })) })) };
  }
  async close(): Promise<void> { await this.engine.close(); this.store.close(); this.vault.clear(); }
}
