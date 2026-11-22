import { lazy, memo, Suspense, useMemo, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import { LayoutDashboard, FolderOpen, Code2, MessagesSquare, GitFork, KeyRound, Plug, WandSparkles, CalendarClock, Brain, History, PackageCheck, Users, Settings as SettingsIcon, Sun, Moon, Menu, PanelRight, X, Shield, ChevronRight, Radio } from 'lucide-react';
import { useConnection, useBootstrap, useWorkspace, useAgent, useNavigation, useNavigationActions, useNotice, useAppActions, viewLabels, type View } from './state';
import { Brand, ProjectGate } from './components/ui';
import { AgentPanel } from './components/AgentPanel';
import { Tray } from './components/Tray';
import { DeferredWorkbench } from './components/DeferredWorkbench';
import { Dashboard } from './views/Dashboard';
import { Projects } from './views/Projects';
import { Sessions } from './views/Sessions';
import { Agents } from './views/Agents';
import { Reports } from './views/Reports';
import { Team } from './views/Team';
type LazyViewModule<P extends object> = { default: ComponentType<P> };
function lazyView<P extends object = {}>(importView: () => Promise<LazyViewModule<P>>, label: string) {
    return lazy(async (): Promise<LazyViewModule<P>> => {
        try {
            return await importView();
        }
        catch {
            const LoadFailure: ComponentType<P> = () => <div className="loading editor-lazy-error" role="alert" aria-live="assertive"><span>Impossible de charger la vue « {label} ».</span><button className="secondary" type="button" onClick={() => window.location.reload()}>Recharger l’application</button></div>;
            return { default: LoadFailure };
        }
    });
}
const Models = lazyView(() => import('./views/Models').then(({ Models }) => ({ default: Models })), 'Modèles');
const Integrations = lazyView(() => import('./views/Integrations').then(({ Integrations }) => ({ default: Integrations })), 'Intégrations');
const Skills = lazyView(() => import('./views/Skills').then(({ Skills }) => ({ default: Skills })), 'Skills');
const Automations = lazyView(() => import('./views/Automations').then(({ Automations }) => ({ default: Automations })), 'Automatisations');
const Memory = lazyView(() => import('./views/Memory').then(({ Memory }) => ({ default: Memory })), 'Mémoire');
const Settings = lazyView(() => import('./views/Settings').then(({ Settings }) => ({ default: Settings })), 'Paramètres');
function ViewLoading({ children }: { children: ReactNode }) {
    return <Suspense fallback={<div className="loading" role="status" aria-live="polite">Chargement de la vue…</div>}>{children}</Suspense>;
}
const NoticeBanner = memo(function NoticeBanner() {
    const { notice } = useNotice();
    const { clearNotice } = useAppActions();
    if (!notice)
        return null;
    return <div className={`app-notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.text}</span><button className="icon-button" aria-label="Fermer la notification" onClick={clearNotice}><X size={15}/></button></div>;
});
const navigation = [
    { id: 'dashboard', icon: LayoutDashboard }, { id: 'projects', icon: FolderOpen }, { id: 'editor', icon: Code2 }, { id: 'sessions', icon: MessagesSquare },
    { id: 'agents', icon: GitFork }, { id: 'models', icon: KeyRound }, { id: 'integrations', icon: Plug }, { id: 'skills', icon: WandSparkles },
    { id: 'automations', icon: CalendarClock }, { id: 'memory', icon: Brain }, { id: 'history', icon: History }, { id: 'delivery', icon: PackageCheck }, { id: 'team', icon: Users },
] as const;
function App() {
    const { connected } = useConnection();
    const { bootstrap } = useBootstrap();
    const { project, projectId, setProjectId } = useWorkspace();
    const { mode } = useAgent();
    const { view } = useNavigation();
    const { setView } = useNavigationActions();
    const [theme, setTheme] = useState('dark');
    const [agentWidth, setAgentWidth] = useState(340);
    const [drawer, setDrawer] = useState(false);
    const [showAgent, setShowAgent] = useState(() => window.innerWidth > 1150);
    const navigate = (target: View) => { setView(target); setDrawer(false); };
    const viewContent = useMemo<ReactNode>(() => {
        switch (view) {
            case 'dashboard': return <Dashboard />;
            case 'projects': return <Projects />;
            case 'models': return <ViewLoading><Models /></ViewLoading>;
            case 'sessions': return <ProjectGate><Sessions /></ProjectGate>;
            case 'agents': return <ProjectGate><Agents /></ProjectGate>;
            case 'integrations': return <ViewLoading><ProjectGate><Integrations /></ProjectGate></ViewLoading>;
            case 'skills': return <ViewLoading><ProjectGate><Skills /></ProjectGate></ViewLoading>;
            case 'automations': return <ViewLoading><ProjectGate><Automations /></ProjectGate></ViewLoading>;
            case 'memory': return <ViewLoading><ProjectGate><Memory /></ProjectGate></ViewLoading>;
            case 'history': return <ProjectGate><Reports /></ProjectGate>;
            case 'delivery': return <ProjectGate><Reports delivery/></ProjectGate>;
            case 'team': return <ProjectGate><Team /></ProjectGate>;
            case 'settings': return <ViewLoading><Settings theme={theme} setTheme={setTheme} width={agentWidth} setWidth={setAgentWidth}/></ViewLoading>;
            case 'editor': return null;
        }
    }, [view, theme, agentWidth]);
    const workbench = useMemo(() => <DeferredWorkbench active={view === 'editor'} theme={theme}/>, [view, theme]);
    const tray = useMemo(() => <Tray />, []);
    const agentPanel = useMemo(() => <AgentPanel />, []);
    return <div className={`app theme-${theme} view-${view} ${drawer ? 'drawer-open' : ''} ${showAgent ? 'agent-open' : ''}`} style={{ '--agent-width': `${agentWidth}px` } as CSSProperties}>
    <nav className="rail" aria-label="Navigation rapide"><button className="rail-brand" aria-label="Vue d’ensemble Open Cortex" onClick={() => navigate('dashboard')}><Brand compact/></button><div className="rail-items">{navigation.map(item => <button key={item.id} className={view === item.id ? 'active' : ''} title={viewLabels[item.id]} aria-label={viewLabels[item.id]} aria-current={view === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><item.icon size={20}/></button>)}</div><div className="rail-bottom"><button title="Changer le thème" aria-label="Changer le thème" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={19}/> : <Moon size={19}/>}</button><button className={view === 'settings' ? 'active' : ''} title="Connexion et paramètres" aria-label="Connexion et paramètres" onClick={() => navigate('settings')}><SettingsIcon size={20}/></button></div></nav>
    <header className="topbar"><div className="topbar-left"><button className="icon-button menu-button" aria-label="Ouvrir la navigation" onClick={() => setDrawer(!drawer)}><Menu size={20}/></button><Brand /><span className="top-divider"/><div className="top-crumb"><span>{project?.name || 'Espace personnel'}</span><ChevronRight size={13}/><strong>{viewLabels[view]}</strong></div></div><div className="topbar-right"><button className={`connection-status ${connected ? 'connected' : ''}`} onClick={() => navigate('settings')}><span className="status-dot"/>{connected ? 'Connecteur local' : 'Moteur déconnecté'}</button><button className="icon-button" aria-label="Afficher ou masquer le panneau agent" title="Panneau agent" onClick={() => setShowAgent(!showAgent)}><PanelRight size={18}/></button></div></header>
    {drawer && <button className="drawer-shade" aria-label="Fermer la navigation" onClick={() => setDrawer(false)}/>}
    <aside className={`context-sidebar ${view === 'editor' ? 'editor-context' : ''}`}><div className="context-title"><span>ESPACE DE TRAVAIL</span><button className="icon-button" title="Ouvrir un projet" aria-label="Ouvrir un projet" onClick={() => navigate('projects')}><FolderOpen size={14}/></button></div><div className="project-selector"><FolderOpen size={17}/><select value={projectId} disabled={!connected} aria-label="Projet actif" onChange={e => setProjectId(e.target.value)}><option value="">Aucun projet ouvert</option>{bootstrap?.projects.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></div><p className="sidebar-project-hint">{project ? project.path : 'Vos fichiers restent sur votre appareil.'}</p><div className="context-nav"><span className="nav-group-label">CONSTRUIRE</span>{navigation.slice(0, 5).map(item => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => navigate(item.id)}><item.icon size={15}/><span>{viewLabels[item.id]}</span>{view === item.id && <span className="nav-active-dot"/>}</button>)}<span className="nav-group-label">CONFIGURER & TRANSMETTRE</span>{navigation.slice(5).map(item => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => navigate(item.id)}><item.icon size={15}/><span>{viewLabels[item.id]}</span></button>)}</div><div className="sidebar-local"><Shield size={17}/><strong>Local, par architecture.</strong><p>Pas de code privé ni de clés sur un backend éditeur.</p><button onClick={() => navigate('settings')}>Voir les frontières <ChevronRight size={12}/></button></div><div className="sidebar-version"><span>OPEN CORTEX</span><code>{bootstrap?.version || '0.1 / INTERFACE'}</code></div></aside>
    <main className="main-region"><NoticeBanner/><div className="view-container">{workbench}{viewContent}</div>{tray}</main>
    {showAgent && <button className="agent-shade" aria-label="Fermer le panneau agent" onClick={() => setShowAgent(false)}/>}
    <div className="agent-region"><button className="agent-mobile-close icon-button" aria-label="Fermer l’agent" onClick={() => setShowAgent(false)}><X size={18}/></button>{agentPanel}</div>
    <footer className="statusbar"><div><Radio size={12}/><span>{connected ? 'LOCAL · PAIRING ACTIF' : 'PREVIEW · DÉCONNECTÉ'}</span><span className="status-separator">/</span><span>{project ? (project.trusted ? 'PROJET APPROUVÉ' : 'LECTURE · NON APPROUVÉ') : 'AUCUN PROJET'}</span></div><div><span>{mode.toUpperCase()}</span><span className="status-separator">/</span><span>{window.cortexDesktop ? 'DESKTOP' : 'WEB'}</span><span>UTF-8</span></div></footer>
  </div>;
}
export default memo(App);
