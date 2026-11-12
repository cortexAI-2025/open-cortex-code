import { useState } from 'react';
import { FolderOpen, ArrowUpRight, FolderPlus } from 'lucide-react';
import type { Project } from '../../shared/contracts';
import { useApp } from '../state';
import { dateLabel } from '../api';
import { Empty, Field, SectionHeading } from '../components/ui';
export function Projects() {
    const { api, bootstrap, connected, act, refresh, setProjectId, setView, confirm } = useApp();
    const [name, setName] = useState('');
    const [path, setPath] = useState('');
    const [trusted, setTrusted] = useState(false);
    const [busy, setBusy] = useState(false);
    if (!connected)
        return <Empty title="Vos projets restent sur votre appareil" detail="L’association locale est nécessaire pour lire les dossiers réels. Aucun dépôt d’exemple n’est créé."><button className="primary" onClick={() => setView('settings')}>Associer le connecteur</button></Empty>;
    return <div className="page-scroll management-page"><SectionHeading index="02" title="Vos projets" detail="Des dossiers réels, une mémoire indépendante. Aucun clonage implicite."/>
    <div className="split-management"><section><div className="panel-title"><FolderOpen size={17}/><h3>Dossiers enregistrés</h3><span className="badge">{bootstrap?.projects.length ?? 0}</span></div>
      {!bootstrap?.projects.length && <Empty title="Aucun projet ouvert" detail="Indiquez le chemin absolu d’un dossier existant sur l’appareil du connecteur."/>}
      <div className="item-list">{bootstrap?.projects.map(project => <button className="project-item" key={project.id} onClick={() => { setProjectId(project.id); setView('editor'); }}><FolderOpen size={20}/><div><strong>{project.name}</strong><code>{project.path}</code><small>{dateLabel(project.updatedAt)} · {project.trusted ? 'Exécution approuvée' : 'Lecture · non approuvé'}</small></div><ArrowUpRight size={16}/></button>)}</div>
    </section><section className="form-panel"><div className="panel-title"><FolderPlus size={17}/><h3>Ouvrir un dossier</h3></div><form onSubmit={async (e) => {
            e.preventDefault();
            if (!api)
                return;
            if (trusted && !await confirm('Approuver ce projet pour l’exécution ?', `Le connecteur pourra exécuter les commandes autorisées dans ${path}. Les permissions d’agent et les worktrees ne constituent pas un sandbox OS. Refusez pour tout code non fiable.`))
                return;
            setBusy(true);
            const result = await act(() => api.request<Project>('/projects', 'POST', { name, path, trusted }), 'Projet ouvert depuis le système de fichiers local.');
            if (result) {
                await act(refresh);
                setProjectId(result.id);
                setView('editor');
            }
            setBusy(false);
        }}><Field label="Nom du projet"><input required value={name} onChange={e => setName(e.target.value)} placeholder="Nom de votre atelier"/></Field><Field label="Chemin absolu sur votre appareil"><input required value={path} onChange={e => setPath(e.target.value)} placeholder="/chemin/vers/mon-projet" spellCheck={false}/></Field>
      {window.cortexDesktop && <button type="button" className="secondary" onClick={() => void act(async () => { const directory = await window.cortexDesktop!.chooseDirectory(); if (directory) {
        setPath(directory);
        if (!name)
            setName(directory.split(/[\\/]/).filter(Boolean).at(-1) || 'Projet');
    } })}>Choisir un dossier…</button>}
      <label className="check-field"><input type="checkbox" checked={trusted} onChange={e => setTrusted(e.target.checked)}/> J’ai examiné ce code et j’approuve l’exécution locale explicite.</label><p className="small">Code non fiable : utiliser un environnement externe isolé. Un worktree isole Git, pas les processus ni les secrets.</p><button className="primary" disabled={busy}><FolderOpen size={16}/>Ouvrir le dossier réel</button>
    </form></section></div>
  </div>;
}
