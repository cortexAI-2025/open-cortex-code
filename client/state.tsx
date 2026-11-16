import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentMode, Bootstrap, CortexSession, Project } from '../shared/contracts';
import { LocalApi, errorText, isLoopback, parseConnection, type Connection } from './api';

export type View = 'dashboard' | 'projects' | 'editor' | 'sessions' | 'agents' | 'models' | 'integrations' | 'skills' | 'automations' | 'memory' | 'history' | 'delivery' | 'settings';
export const viewLabels: Record<View, string> = {
    dashboard: 'Vue d’ensemble', projects: 'Projets', editor: 'Éditeur', sessions: 'Sessions', agents: 'Agents parallèles', models: 'Modèles & clés', integrations: 'MCP & API', skills: 'Skills', automations: 'Automatisations', memory: 'Mémoire & connaissances', history: 'Historique', delivery: 'Livraison', settings: 'Connexion & paramètres',
};

interface Notice {
    text: string;
    kind: 'error' | 'success';
}
interface ConfirmState {
    title: string;
    detail: string;
    resolve: (value: boolean) => void;
}

export interface ConnectionDomain {
    api: LocalApi | null;
    connected: boolean;
    remote: boolean;
    connect: (url: string, token: string, remote?: boolean, pairingId?: string) => Promise<boolean>;
    disconnect: () => void;
    refresh: () => Promise<void>;
}
export interface ConnectingDomain {
    connecting: boolean;
}
export interface WorkspaceDomain {
    project: Project | null;
    projectId: string;
    setProjectId: (id: string) => Promise<boolean>;
}
export interface UnsavedDomain {
    unsaved: boolean;
}
export interface UnsavedActions {
    setUnsaved: (value: boolean) => void;
}
export interface AgentDomain {
    profileId: string;
    setProfileId: (id: string) => void;
    mode: AgentMode;
    setMode: (mode: AgentMode) => void;
    session: CortexSession | null;
    setSession: (session: CortexSession | null) => void;
}
export interface NavigationDomain {
    view: View;
}
export interface NavigationActions {
    setView: (view: View) => void;
}
export interface NotificationDomain {
    notice: Notice | null;
}
export interface AppActions {
    notify: (text: string, kind?: Notice['kind']) => void;
    clearNotice: () => void;
    confirm: (title: string, detail: string) => Promise<boolean>;
    act: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
}
interface BootstrapDomain {
    bootstrap: Bootstrap | null;
}

const ConnectionContext = createContext<ConnectionDomain | null>(null);
const ConnectingContext = createContext<ConnectingDomain | null>(null);
const BootstrapContext = createContext<BootstrapDomain | null>(null);
const WorkspaceContext = createContext<WorkspaceDomain | null>(null);
const UnsavedContext = createContext<UnsavedDomain | null>(null);
const UnsavedActionsContext = createContext<UnsavedActions | null>(null);
const AgentContext = createContext<AgentDomain | null>(null);
const NavigationContext = createContext<NavigationDomain | null>(null);
const NavigationActionsContext = createContext<NavigationActions | null>(null);
const NotificationContext = createContext<NotificationDomain | null>(null);
const AppActionsContext = createContext<AppActions | null>(null);

let fragmentToken = '';
if (typeof window !== 'undefined') {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    fragmentToken = fragment.get('token') || '';
    if (fragment.has('token')) {
        fragment.delete('token');
        history.replaceState(null, '', `${location.pathname}${location.search}${fragment.size ? `#${fragment}` : ''}`);
    }
}

function sameProject(a: Project | null, b: Project | null): boolean {
    if (a === b)
        return true;
    if (!a || !b)
        return false;
    return a.id === b.id && a.name === b.name && a.path === b.path && a.trusted === b.trusted && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt;
}

function requiredContext<T>(value: T | null, name: string): T {
    if (!value)
        throw new Error(`${name} doit être utilisé sous AppProvider`);
    return value;
}

export function AppProvider({ children }: {
    children: ReactNode;
}) {
    const [api, setApi] = useState<LocalApi | null>(null);
    const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
    const [reachable, setReachable] = useState(false);
    const [connecting, setConnecting] = useState(false);
    const [projectId, setProjectId] = useState('');
    const [profileId, setProfileId] = useState('');
    const [mode, setMode] = useState<AgentMode>('ask');
    const [session, setSession] = useState<CortexSession | null>(null);
    const [view, setView] = useState<View>('dashboard');
    const [unsaved, setUnsaved] = useState(false);
    const [notice, setNotice] = useState<Notice | null>(null);
    const [confirmation, setConfirmation] = useState<ConfirmState | null>(null);

    const notify = useCallback((text: string, kind: Notice['kind'] = 'error') => setNotice({ text, kind }), []);
    const clearNotice = useCallback(() => setNotice(null), []);
    const confirm = useCallback((title: string, detail: string) => new Promise<boolean>(resolve => setConfirmation({ title, detail, resolve })), []);
    const act = useCallback(async <T,>(action: () => Promise<T>, success?: string): Promise<T | undefined> => {
        try {
            const result = await action();
            if (success)
                notify(success, 'success');
            return result;
        }
        catch (e) {
            notify(errorText(e));
            return undefined;
        }
    }, [notify]);

    // Stable commands read the latest guard values without making unrelated contexts change identity.
    const connectionGuards = useRef({ unsaved, confirm, notify });
    connectionGuards.current = { unsaved, confirm, notify };
    const connect = useCallback(async (url: string, token: string, remote = false, pairingId?: string): Promise<boolean> => {
        const guards = connectionGuards.current;
        if (guards.unsaved && !await guards.confirm('Réassocier l’atelier sans enregistrer ?', 'Le changement de connecteur abandonnera vos brouillons ouverts. Annulez pour les enregistrer d’abord.'))
            return false;
        setConnecting(true);
        setNotice(null);
        try {
            const candidate = new LocalApi(parseConnection(url, token, remote, pairingId));
            const health = await candidate.request<{
                healthy: boolean;
                localOnly: boolean;
            }>('/health', 'GET', undefined, AbortSignal.timeout(6000));
            if (!health.healthy || !health.localOnly)
                throw new Error('Ce service ne confirme pas être un connecteur local opérationnel.');
            const result = await candidate.request<Bootstrap>('/bootstrap');
            if (!Array.isArray(result.projects) || !Array.isArray(result.profiles))
                throw new Error('Le service local ne respecte pas le contrat bootstrap attendu.');
            setApi(candidate);
            setBootstrap(result);
            setReachable(true);
            setProjectId('');
            setSession(null);
            setProfileId(result.profiles[0]?.id || '');
            guards.notify(remote ? 'Connecteur local associé après approbation locale. Le jeton distant reste en mémoire de cet onglet.' : 'Connecteur local associé. Les fichiers restent fermés jusqu’au choix d’un projet.', 'success');
            return true;
        }
        catch (e) {
            guards.notify(errorText(e));
            return false;
        }
        finally {
            setConnecting(false);
        }
    }, []);
    const disconnect = useCallback(() => {
        setApi(null);
        setBootstrap(null);
        setProjectId('');
        setProfileId('');
        setSession(null);
        setView('dashboard');
    }, []);
    const refresh = useCallback(async () => {
        if (api)
            setBootstrap(await api.request<Bootstrap>('/bootstrap'));
    }, [api]);

    useEffect(() => {
        if (!api) {
            setReachable(false);
            return;
        }
        let active = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let failed = false;
        const heartbeat = async () => {
            try {
                const health = await api.request<{
                    healthy: boolean;
                    localOnly: boolean;
                }>('/health', 'GET', undefined, AbortSignal.timeout(5000));
                if (!health.healthy || !health.localOnly)
                    throw new Error('Le connecteur ne confirme plus un moteur local opérationnel.');
                const current = await api.request<Bootstrap>('/bootstrap', 'GET', undefined, AbortSignal.timeout(5000));
                if (active) {
                    setBootstrap(current);
                    setReachable(true);
                    if (failed)
                        notify('Connecteur local de nouveau accessible.', 'success');
                    failed = false;
                }
            }
            catch (error) {
                if (active) {
                    setReachable(false);
                    if (!failed)
                        notify(errorText(error));
                    failed = true;
                }
            }
            if (active)
                timer = setTimeout(heartbeat, 8000);
        };
        timer = setTimeout(heartbeat, 8000);
        return () => { active = false; clearTimeout(timer); };
    }, [api, notify]);

    useEffect(() => {
        const initial = async () => {
            if (window.cortexDesktop) {
                try {
                    const connection: Connection = await window.cortexDesktop.getConnection();
                    await connect(connection.url, connection.token);
                }
                catch (e) {
                    notify(`Bridge Desktop : ${errorText(e)}`);
                }
            }
            else if (isLoopback(location.hostname)) {
                // Probe sans secret seulement sur l’origine locale. Aucun essai automatique en Preview hébergée.
                try {
                    const health = await fetch('/api/health', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(3000) });
                    const data = await health.json() as {
                        healthy?: boolean;
                        localOnly?: boolean;
                    };
                    if (data.healthy && data.localOnly && fragmentToken) {
                        const token = fragmentToken;
                        fragmentToken = '';
                        await connect(location.origin, token);
                    }
                }
                catch { /* Vite local sans connecteur : conserver l’état déconnecté. */ }
            }
            fragmentToken = '';
        };
        void initial();
    }, [connect, notify]);

    const agentGuards = useRef({ projectId, unsaved, confirm });
    agentGuards.current = { projectId, unsaved, confirm };
    const selectProject = useCallback(async (id: string): Promise<boolean> => {
        const guards = agentGuards.current;
        if (id === guards.projectId)
            return true;
        if (guards.unsaved && !await guards.confirm('Changer de projet sans enregistrer ?', 'Les brouillons ouverts dans l’éditeur seront abandonnés. Annulez pour les enregistrer d’abord.'))
            return false;
        setProjectId(id);
        setSession(null);
        setUnsaved(false);
        return true;
    }, []);

    const candidateProject = bootstrap?.projects.find(p => p.id === projectId) || null;
    const projectRef = useRef<Project | null>(candidateProject);
    if (!sameProject(projectRef.current, candidateProject))
        projectRef.current = candidateProject;
    const project = projectRef.current;

    const connection = useMemo<ConnectionDomain>(() => ({
        api,
        connected: Boolean(api && bootstrap && reachable),
        remote: Boolean(api?.connection.remote),
        connect,
        disconnect,
        refresh,
    }), [api, Boolean(bootstrap), reachable, connect, disconnect, refresh]);
    const connectingDomain = useMemo<ConnectingDomain>(() => ({ connecting }), [connecting]);
    const bootstrapDomain = useMemo<BootstrapDomain>(() => ({ bootstrap }), [bootstrap]);
    const workspace = useMemo<WorkspaceDomain>(() => ({
        project,
        projectId,
        setProjectId: selectProject,
    }), [project, projectId, selectProject]);
    const unsavedDomain = useMemo<UnsavedDomain>(() => ({ unsaved }), [unsaved]);
    const unsavedActions = useMemo<UnsavedActions>(() => ({ setUnsaved }), [setUnsaved]);
    const agent = useMemo<AgentDomain>(() => ({
        profileId,
        setProfileId,
        mode,
        setMode,
        session,
        setSession,
    }), [profileId, mode, session]);
    const navigation = useMemo<NavigationDomain>(() => ({ view }), [view]);
    const navigationActions = useMemo<NavigationActions>(() => ({ setView }), [setView]);
    const notifications = useMemo<NotificationDomain>(() => ({ notice }), [notice]);
    const actions = useMemo<AppActions>(() => ({ notify, clearNotice, confirm, act }), [notify, clearNotice, confirm, act]);

    const finishConfirmation = (answer: boolean) => { confirmation?.resolve(answer); setConfirmation(null); };

    return <ConnectionContext.Provider value={connection}>
      <ConnectingContext.Provider value={connectingDomain}>
        <BootstrapContext.Provider value={bootstrapDomain}>
          <WorkspaceContext.Provider value={workspace}>
            <UnsavedContext.Provider value={unsavedDomain}>
              <UnsavedActionsContext.Provider value={unsavedActions}>
                <AgentContext.Provider value={agent}>
                  <NavigationContext.Provider value={navigation}>
                    <NavigationActionsContext.Provider value={navigationActions}>
                      <NotificationContext.Provider value={notifications}>
                        <AppActionsContext.Provider value={actions}>
                    {children}
                    {confirmation && <div className="modal-backdrop" onKeyDown={e => { if (e.key === 'Escape') finishConfirmation(false); }}>
                      <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
                        <span className="eyebrow">AUTORISATION EXPLICITE</span><h2 id="confirm-title">{confirmation.title}</h2><p>{confirmation.detail}</p>
                        <div className="button-row"><button autoFocus className="secondary" onClick={() => finishConfirmation(false)}>Annuler</button><button className="primary" onClick={() => finishConfirmation(true)}>Confirmer cette action</button></div>
                      </section>
                    </div>}
                        </AppActionsContext.Provider>
                      </NotificationContext.Provider>
                    </NavigationActionsContext.Provider>
                  </NavigationContext.Provider>
                </AgentContext.Provider>
              </UnsavedActionsContext.Provider>
            </UnsavedContext.Provider>
          </WorkspaceContext.Provider>
        </BootstrapContext.Provider>
      </ConnectingContext.Provider>
    </ConnectionContext.Provider>;
}

export function useConnection(): ConnectionDomain {
    return requiredContext(useContext(ConnectionContext), 'useConnection');
}
export function useConnecting(): boolean {
    return requiredContext(useContext(ConnectingContext), 'useConnecting').connecting;
}
export function useBootstrap(): BootstrapDomain {
    return requiredContext(useContext(BootstrapContext), 'useBootstrap');
}
export function useWorkspace(): WorkspaceDomain {
    return requiredContext(useContext(WorkspaceContext), 'useWorkspace');
}
export function useUnsaved(): boolean {
    return requiredContext(useContext(UnsavedContext), 'useUnsaved').unsaved;
}
export function useUnsavedActions(): UnsavedActions {
    return requiredContext(useContext(UnsavedActionsContext), 'useUnsavedActions');
}
export function useAgent(): AgentDomain {
    return requiredContext(useContext(AgentContext), 'useAgent');
}
export function useNavigation(): NavigationDomain {
    return requiredContext(useContext(NavigationContext), 'useNavigation');
}
export function useNavigationActions(): NavigationActions {
    return requiredContext(useContext(NavigationActionsContext), 'useNavigationActions');
}
export function useNotice(): NotificationDomain {
    return requiredContext(useContext(NotificationContext), 'useNotice');
}
export function useAppActions(): AppActions {
    return requiredContext(useContext(AppActionsContext), 'useAppActions');
}

/** @deprecated Prefer the domain-specific hooks to avoid subscribing to unrelated context changes. */
export function useApp() {
    return {
        ...useConnection(),
        connecting: useConnecting(),
        bootstrap: useBootstrap().bootstrap,
        ...useWorkspace(),
        unsaved: useUnsaved(),
        ...useUnsavedActions(),
        ...useAgent(),
        ...useNavigation(),
        ...useNavigationActions(),
        ...useNotice(),
        ...useAppActions(),
    };
}
