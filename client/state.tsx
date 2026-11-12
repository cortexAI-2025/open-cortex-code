import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
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
interface State {
    api: LocalApi | null;
    bootstrap: Bootstrap | null;
    connected: boolean;
    connecting: boolean;
    remote: boolean;
    connect: (url: string, token: string, remote?: boolean, pairingId?: string) => Promise<boolean>;
    disconnect: () => void;
    refresh: () => Promise<void>;
    project: Project | null;
    projectId: string;
    setProjectId: (id: string) => Promise<boolean>;
    profileId: string;
    setProfileId: (id: string) => void;
    mode: AgentMode;
    setMode: (mode: AgentMode) => void;
    unsaved: boolean;
    setUnsaved: (value: boolean) => void;
    session: CortexSession | null;
    setSession: (session: CortexSession | null) => void;
    view: View;
    setView: (view: View) => void;
    notice: Notice | null;
    notify: (text: string, kind?: Notice['kind']) => void;
    clearNotice: () => void;
    confirm: (title: string, detail: string) => Promise<boolean>;
    act: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
}
const Context = createContext<State | null>(null);
let fragmentToken = '';
if (typeof window !== 'undefined') {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    fragmentToken = fragment.get('token') || '';
    if (fragment.has('token')) {
        fragment.delete('token');
        history.replaceState(null, '', `${location.pathname}${location.search}${fragment.size ? `#${fragment}` : ''}`);
    }
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
    const notify = (text: string, kind: Notice['kind'] = 'error') => setNotice({ text, kind });
    const disconnect = () => { setApi(null); setBootstrap(null); setProjectId(''); setProfileId(''); setSession(null); setView('dashboard'); };
    const connect = async (url: string, token: string, remote = false, pairingId?: string) => {
        if (unsaved && !await confirm('Réassocier l’atelier sans enregistrer ?', 'Le changement de connecteur abandonnera vos brouillons ouverts. Annulez pour les enregistrer d’abord.'))
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
            notify(remote ? 'Connecteur local associé après approbation locale. Le jeton distant reste en mémoire de cet onglet.' : 'Connecteur local associé. Les fichiers restent fermés jusqu’au choix d’un projet.', 'success');
            return true;
        }
        catch (e) {
            notify(errorText(e));
            return false;
        }
        finally {
            setConnecting(false);
        }
    };
    const refresh = async () => { if (api)
        setBootstrap(await api.request<Bootstrap>('/bootstrap')); };
    const act = async <T,>(action: () => Promise<T>, success?: string): Promise<T | undefined> => {
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
    };
    const confirm = (title: string, detail: string) => new Promise<boolean>(resolve => setConfirmation({ title, detail, resolve }));
    const finishConfirmation = (answer: boolean) => { confirmation?.resolve(answer); setConfirmation(null); };
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
    }, [api]);
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
    }, []);
    const selectProject = async (id: string): Promise<boolean> => {
        if (id === projectId)
            return true;
        if (unsaved && !await confirm('Changer de projet sans enregistrer ?', 'Les brouillons ouverts dans l’éditeur seront abandonnés. Annulez pour les enregistrer d’abord.'))
            return false;
        setProjectId(id);
        setSession(null);
        setUnsaved(false);
        return true;
    };
    const value: State = {
        api, bootstrap, connected: Boolean(api && bootstrap && reachable), connecting, remote: Boolean(api?.connection.remote), connect, disconnect, refresh,
        project: bootstrap?.projects.find(p => p.id === projectId) || null, projectId, setProjectId: selectProject,
        profileId, setProfileId, mode, setMode, unsaved, setUnsaved, session, setSession, view, setView, notice, notify, clearNotice: () => setNotice(null), confirm, act,
    };
    return <Context.Provider value={value}>{children}{confirmation && <div className="modal-backdrop" onKeyDown={e => { if (e.key === 'Escape')
            finishConfirmation(false); }}>
    <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
      <span className="eyebrow">AUTORISATION EXPLICITE</span><h2 id="confirm-title">{confirmation.title}</h2><p>{confirmation.detail}</p>
      <div className="button-row"><button autoFocus className="secondary" onClick={() => finishConfirmation(false)}>Annuler</button><button className="primary" onClick={() => finishConfirmation(true)}>Confirmer cette action</button></div>
    </section></div>}</Context.Provider>;
}
export function useApp() { const context = useContext(Context); if (!context)
    throw new Error('AppProvider requis'); return context; }
