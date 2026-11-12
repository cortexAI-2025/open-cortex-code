import { useEffect, useState } from 'react';
import '../file-checkpoints.css';
import MonacoEditor from '@monaco-editor/react';
import { Code2, Save, X, FileCode2, History, RotateCcw } from 'lucide-react';
import type { FileContent } from '../../shared/contracts';
import { projectRoute } from '../api';
import { useApp } from '../state';
import { FileTree } from './FileTree';
import { Empty, Loading } from './ui';
interface Tab extends FileContent {
    draft: string;
}
interface FileCheckpoint { id: string; path: string; content: string; hash: string; createdAt: string }
export function Workbench({ theme }: {
    theme: string;
}) {
    const { api, project, projectId, act, confirm, setView, setUnsaved } = useApp();
    const [tabs, setTabs] = useState<Tab[]>([]);
    const [active, setActive] = useState('');
    const [busy, setBusy] = useState(false);
    const [checkpoints, setCheckpoints] = useState<FileCheckpoint[]>([]);
    const [showCheckpoints, setShowCheckpoints] = useState(false);
    const current = tabs.find(t => t.path === active);
    const dirty = tabs.some(tab => tab.draft !== tab.content);
    useEffect(() => { setUnsaved(dirty); }, [dirty]);
    useEffect(() => { setTabs([]); setActive(''); }, [projectId, api]);
    useEffect(() => { setShowCheckpoints(false); setCheckpoints([]); }, [active, projectId]);
    useEffect(() => {
        const prevent = (event: BeforeUnloadEvent) => { if (dirty) {
            event.preventDefault();
            event.returnValue = '';
        } };
        window.addEventListener('beforeunload', prevent);
        return () => window.removeEventListener('beforeunload', prevent);
    }, [dirty]);
    const open = async (path: string) => {
        if (!api || !projectId)
            return;
        if (tabs.some(tab => tab.path === path)) {
            setActive(path);
            return;
        }
        setBusy(true);
        const result = await act(() => api.request<FileContent>(`${projectRoute(projectId, 'file')}?path=${encodeURIComponent(path)}`));
        if (result) {
            setTabs(prev => prev.some(t => t.path === result.path) ? prev : [...prev, { ...result, draft: result.content }]);
            setActive(result.path);
        }
        setBusy(false);
    };
    const save = async () => {
        if (!api || !projectId || !current || current.draft === current.content)
            return;
        if (!await confirm('Enregistrer le fichier ?', `${current.path} sera modifié sur votre appareil. Le connecteur vérifie le hash original et crée un point de sécurité. Si le fichier a changé ailleurs, la sauvegarde sera refusée : rechargez pour comparer, sans écrasement forcé.`))
            return;
        setBusy(true);
        const result = await act(() => api.request<FileContent>(projectRoute(projectId, 'file'), 'PUT', { path: current.path, content: current.draft, hash: current.hash, confirm: true }), 'Fichier enregistré et hash actualisé.');
        if (result)
            setTabs(prev => prev.map(t => t.path === result.path ? { ...result, draft: result.content } : t));
        setBusy(false);
    };
    const loadCheckpoints = async () => {
        if (!api || !projectId || !current) return;
        const result = await act(() => api.request<FileCheckpoint[]>(`${projectRoute(projectId, 'file-checkpoints')}?path=${encodeURIComponent(current.path)}`));
        if (result) { setCheckpoints(result); setShowCheckpoints(true); }
    };
    const restore = async (checkpoint: FileCheckpoint) => {
        if (!api || !projectId || !current || current.draft !== current.content) return;
        if (!await confirm('Restaurer ce point ?', `Le fichier ${current.path} sera remplacé par la version du ${new Date(checkpoint.createdAt).toLocaleString('fr-FR')}. Le hash courant sera revalidé et la version actuelle sera elle-même sauvegardée avant restauration.`)) return;
        setBusy(true);
        const result = await act(() => api.request<FileContent>(`${projectRoute(projectId, 'file-checkpoints')}/${encodeURIComponent(checkpoint.id)}/restore`, 'POST', { path: current.path, expectedHash: current.hash, confirm: true }), 'Version restaurée; nouvelle sauvegarde créée.');
        if (result) setTabs(prev => prev.map(tab => tab.path === result.path ? { ...result, draft: result.content } : tab));
        await loadCheckpoints();
        setBusy(false);
    };
    const close = async (tab: Tab) => {
        if (tab.draft !== tab.content && !await confirm('Fermer le fichier sans enregistrer ?', `Le brouillon de ${tab.path} sera abandonné. Le fichier sur disque ne sera pas modifié.`))
            return;
        setTabs(prev => prev.filter(t => t.path !== tab.path));
        if (active === tab.path)
            setActive(tabs.find(t => t.path !== tab.path)?.path || '');
    };
    return <div className="workbench"><FileTree selected={active} onOpen={path => void open(path)}/><section className="editor-surface"><div className="file-tabs">{tabs.map(tab => <div key={tab.path} className={`file-tab ${active === tab.path ? 'active' : ''}`}><button onClick={() => setActive(tab.path)}><FileCode2 size={14}/>{tab.path.split('/').at(-1)}{tab.draft !== tab.content && <span className="dirty-dot" aria-label="Modification non sauvegardée"/>}</button><button className="close-tab" onClick={() => void close(tab)} aria-label={`Fermer ${tab.path}`}><X size={13}/></button></div>)}{!tabs.length && <div className="empty-tab"><Code2 size={14}/>Éditeur</div>}</div>
    <div className="editor-breadcrumb"><span className="mono">{current?.path || (project ? `${project.name} / aucun fichier sélectionné` : 'Aucun projet réel ouvert')}</span>{current && <div className="button-row"><button className="text-action" disabled={busy} onClick={() => void loadCheckpoints()}><History size={13}/>Restaurations</button><button className="text-action" disabled={busy} onClick={async () => { if (current.draft !== current.content && !await confirm('Recharger depuis le disque ?', 'Le brouillon non enregistré sera perdu. Le fichier réel sera relu sans mutation.'))
        return; if (!api)
        return; const result = await act(() => api.request<FileContent>(`${projectRoute(projectId, 'file')}?path=${encodeURIComponent(current.path)}`)); if (result)
        setTabs(prev => prev.map(t => t.path === result.path ? { ...result, draft: result.content } : t)); }}>Recharger</button><button className="secondary save-button" disabled={busy || current.content === current.draft} onClick={() => void save()}><Save size={13}/>Enregistrer</button></div>}</div>
      {showCheckpoints && <section className="file-checkpoints"><header><strong><History size={13}/> Versions locales · {current?.path}</strong><button className="icon-button" aria-label="Fermer les restaurations" onClick={() => setShowCheckpoints(false)}><X size={14}/></button></header>{checkpoints.length ? checkpoints.map(checkpoint => <article key={checkpoint.id}><div><strong>{new Date(checkpoint.createdAt).toLocaleString('fr-FR')}</strong><small>sha256 · {checkpoint.hash.slice(0, 14)}</small><pre>{checkpoint.content.slice(0, 12000)}{checkpoint.content.length > 12000 ? '\n… aperçu tronqué' : ''}</pre></div><button className="secondary" disabled={busy || !current || current.draft !== current.content} onClick={() => void restore(checkpoint)}><RotateCcw size={13}/>Restaurer</button></article>) : <p className="small">Aucun checkpoint antérieur trouvé pour ce fichier.</p>}</section>}
      {busy && !current && <Loading />}{current ? <MonacoEditor path={current.path} value={current.draft} theme={theme === 'light' ? 'cortex-light' : 'cortex-dark'} onChange={value => setTabs(prev => prev.map(tab => tab.path === active ? { ...tab, draft: value ?? '' } : tab))} onMount={editor => { editor.addAction({ id: 'cortex-save', label: 'Enregistrer avec confirmation', keybindings: [2048 | 49], run: () => void document.querySelector<HTMLButtonElement>('.save-button')?.click() }); }} options={{ fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', fontSize: 13, lineHeight: 22, minimap: { enabled: false }, padding: { top: 16 }, scrollBeyondLastLine: false, automaticLayout: true, smoothScrolling: true, tabSize: 2 }} loading={<Loading />}/> : <Empty title={project ? 'Le code, au centre.' : 'Ouvrez votre propre atelier.'} detail={project ? 'Choisissez un fichier dans l’explorateur. L’éditeur ne charge que le contenu réellement renvoyé par votre connecteur.' : 'Aucun projet ni fichier d’exemple. Associez le moteur local puis ouvrez un dossier existant.'}><button className="primary" onClick={() => setView('projects')}>Ouvrir un projet</button><p className="small">Ctrl+S · Enregistrer avec confirmation</p></Empty>}
    </section></div>;
}
