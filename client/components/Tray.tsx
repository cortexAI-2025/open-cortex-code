import { useState } from 'react';
import { Terminal, FlaskConical, GitBranch, ExternalLink, ChevronUp, ChevronDown } from 'lucide-react';
import { useApp } from '../state';
import { isLoopback } from '../api';
import { CommandPanel } from './CommandPanel';
import { GitPanel } from './GitPanel';
import { Empty, ProjectGate } from './ui';
export function Tray() {
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState<'commands' | 'tests' | 'git' | 'preview'>('commands');
    const items = [{ id: 'commands', title: 'Commandes', icon: Terminal }, { id: 'tests', title: 'Tests', icon: FlaskConical }, { id: 'git', title: 'Git & diff', icon: GitBranch }, { id: 'preview', title: 'Preview', icon: ExternalLink }] as const;
    return <section className={`bottom-tray ${open ? 'open' : ''}`} aria-label="Commandes et résultats"><header className="tray-tabs"><div>{items.map(item => <button key={item.id} className={open && tab === item.id ? 'active' : ''} onClick={() => { setTab(item.id); setOpen(true); }}><item.icon size={14}/>{item.title}</button>)}</div><button className="icon-button" aria-label={open ? 'Fermer le tiroir' : 'Ouvrir le tiroir'} title={open ? 'Fermer le tiroir' : 'Ouvrir le tiroir'} onClick={() => setOpen(!open)}>{open ? <ChevronDown size={16}/> : <ChevronUp size={16}/>}</button></header>{open && <div className="tray-body"><ProjectGate>{tab === 'commands' ? <CommandPanel /> : tab === 'tests' ? <CommandPanel tests/> : tab === 'git' ? <GitPanel /> : <Preview />}</ProjectGate></div>}</section>;
}
function Preview() {
    const { confirm, act } = useApp();
    const [url, setUrl] = useState('');
    return <div className="preview-panel"><Empty title="Aperçu externe, explicitement autorisé" detail="L’application ne lance pas de serveur caché. Démarrez votre application dans un environnement approprié, puis ouvrez son URL loopback dans une fenêtre séparée."/><form className="inline-form" onSubmit={async (e) => { e.preventDefault(); await act(async () => { const target = new URL(url); if (!['http:', 'https:'].includes(target.protocol) || !isLoopback(target.hostname) || target.username || target.password)
        throw new Error('Seules les URL HTTP(S) loopback sans identifiants sont autorisées ici.'); if (!await confirm('Ouvrir cet aperçu local ?', `${target.origin} sera ouvert dans une fenêtre séparée, sans privilèges Desktop ni accès au jeton Cortex. Vérifiez que le serveur correspond à votre projet autorisé.`))
        return; const link = document.createElement('a'); link.href = target.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.click(); }); }}><input value={url} onChange={e => setUrl(e.target.value)} type="url" required placeholder="http://localhost:…" aria-label="URL de prévisualisation locale"/><button className="primary"><ExternalLink size={14}/>Ouvrir l’aperçu</button></form><p className="small">Pas de lancement automatique, de sandbox prétendu ou de chargement de code non fiable dans le processus principal.</p></div>;
}
