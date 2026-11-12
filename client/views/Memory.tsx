import { useState } from 'react';
import { Brain, BookOpen, Search, Upload, Plus, Trash2 } from 'lucide-react';
import type { KnowledgeDocument, MemoryEntry } from '../../shared/contracts';
import { dateLabel, projectRoute, useResource } from '../api';
import { useApp } from '../state';
import { Empty, ErrorBox, Field, Loading, SectionHeading } from '../components/ui';
interface Document extends KnowledgeDocument {
    hash?: string;
}
interface Passage {
    documentId: string;
    name: string;
    text: string;
    score: number;
}
export function Memory() {
    const { api, projectId, act, confirm } = useApp();
    const [tab, setTab] = useState<'memory' | 'knowledge'>('memory');
    const [query, setQuery] = useState('');
    const [search, setSearch] = useState('');
    const memories = useResource<MemoryEntry[]>(api, projectId ? projectRoute(projectId, 'memory') : null);
    const documents = useResource<Document[]>(api, projectId ? projectRoute(projectId, 'knowledge') : null);
    const passages = useResource<Passage[]>(api, projectId && search ? `${projectRoute(projectId, 'knowledge/search')}?q=${encodeURIComponent(search)}` : null);
    const [editing, setEditing] = useState<MemoryEntry | Document | null>(null);
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');
    const [kind, setKind] = useState<MemoryEntry['kind']>('note');
    const [busy, setBusy] = useState(false);
    const reset = () => { setEditing(null); setTitle(''); setContent(''); setKind('note'); };
    const edit = (item: MemoryEntry | Document) => { setEditing(item); setTitle('title' in item ? item.title : item.name); setContent(item.content); if ('kind' in item)
        setKind(item.kind); };
    return <div className="page-scroll management-page"><SectionHeading index="08" title="Mémoire & connaissances" detail="Décisions, instructions et passages documentaires conservés par votre connecteur, séparément pour ce projet."/>
    <div className="sub-tabs"><button className={tab === 'memory' ? 'active' : ''} onClick={() => { setTab('memory'); reset(); }}><Brain size={15}/>Mémoire du projet</button><button className={tab === 'knowledge' ? 'active' : ''} onClick={() => { setTab('knowledge'); reset(); }}><BookOpen size={15}/>Documents & passages</button></div>
    <div className="split-management"><section><form className="search-form" onSubmit={e => { e.preventDefault(); setSearch(query.trim()); }}><Search size={16}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder={tab === 'memory' ? 'Filtrer les notes locales…' : 'Chercher des passages dans les documents…'} aria-label="Recherche mémoire et connaissances"/>{tab === 'knowledge' && <button className="secondary">Rechercher</button>}</form>
      <ErrorBox error={tab === 'memory' ? memories.error : documents.error} retry={tab === 'memory' ? memories.refresh : documents.refresh}/>{(tab === 'memory' ? memories.loading : documents.loading) && <Loading />}
      {tab === 'memory' ? <div className="item-list">{memories.data?.filter(item => `${item.title} ${item.content}`.toLowerCase().includes(query.toLowerCase())).map(item => <button className="memory-item" key={item.id} onClick={() => edit(item)}><span className="badge">{item.kind}</span><strong>{item.title}</strong><p>{item.content.slice(0, 220)}</p><small>{dateLabel(item.updatedAt)}</small></button>)}{memories.data?.length === 0 && <Empty title="La mémoire commence ici" detail="Enregistrez une décision ou une instruction utile. Aucune architecture d’exemple n’est préremplie."/>}</div> : <><ErrorBox error={passages.error} retry={passages.refresh}/>{passages.loading && <Loading />}{passages.data?.map((passage, index) => <article className="passage" key={`${passage.documentId}-${index}`}><header><strong>{passage.name}</strong><small>Score recherche : {passage.score}</small></header><p>{passage.text}</p></article>)}{search && passages.data?.length === 0 && <p className="small">Aucun passage correspondant.</p>}<div className="item-list">{documents.data?.map(doc => <div className="document-row" key={doc.id}><button onClick={() => edit(doc)}><BookOpen size={16}/><div><strong>{doc.name}</strong><small>{doc.content.length.toLocaleString('fr-FR')} caractères · {dateLabel(doc.createdAt)}</small></div></button><button className="icon-button" aria-label={`Supprimer ${doc.name}`} title="Supprimer le document" onClick={async () => { if (!api || !await confirm('Supprimer ce document ?', `${doc.name} et ses passages indexés seront retirés de la base locale de ce projet.`))
        return; await act(() => api.request(projectRoute(projectId, `knowledge/${encodeURIComponent(doc.id)}`), 'DELETE', { confirm: true }), 'Document supprimé.'); documents.refresh(); passages.refresh(); if (editing?.id === doc.id)
        reset(); }}><Trash2 size={14}/></button></div>)}</div>{documents.data?.length === 0 && <Empty title="Aucun document indexé" detail="Importez un fichier texte ou Markdown pour retrouver les passages pertinents."/>}</>}
    </section><section className="form-panel"><div className="panel-title"><h3>{editing ? 'Modifier l’entrée' : tab === 'memory' ? 'Nouvelle entrée' : 'Importer un document'}</h3><button className="icon-button" title="Nouvelle entrée" aria-label="Nouvelle entrée" onClick={reset}><Plus size={16}/></button></div><form onSubmit={async (e) => {
            e.preventDefault();
            if (!api)
                return;
            if (editing && !await confirm('Enregistrer la modification ?', 'Cette entrée locale sera mise à jour. Les documents utilisent un hash de concurrence.'))
                return;
            setBusy(true);
            const base = tab === 'memory' ? 'memory' : 'knowledge';
            const body = tab === 'memory' ? { kind, title, content } : { name: title, content, ...(editing ? { confirm: true, expectedHash: (editing as Document).hash } : {}) };
            const result = await act(() => api.request(projectRoute(projectId, editing ? `${base}/${encodeURIComponent(editing.id)}` : base), editing ? 'PUT' : 'POST', body), 'Entrée enregistrée localement.');
            if (result) {
                reset();
                memories.refresh();
                documents.refresh();
                passages.refresh();
            }
            setBusy(false);
        }}>
      {tab === 'knowledge' && !editing && <label className="upload-field"><Upload size={16}/>Choisir un fichier .md / .txt<input type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" onChange={e => { const file = e.target.files?.[0]; if (file)
        void act(async () => { if (file.size > 200000 || !/\.(txt|md|markdown)$/i.test(file.name))
            throw new Error('Fichier texte/Markdown de 200 Ko maximum requis.'); setTitle(file.name); setContent(await file.text()); }); }}/></label>}
      <Field label={tab === 'memory' ? 'Titre' : 'Nom du document (avec extension .md / .txt)'}><input required value={title} onChange={e => setTitle(e.target.value)} maxLength={200}/></Field>{tab === 'memory' && <Field label="Type de mémoire"><select value={kind} onChange={e => setKind(e.target.value as MemoryEntry['kind'])}>{['note', 'decision', 'instruction', 'task', 'error'].map(value => <option key={value} value={value}>{value}</option>)}</select></Field>}
      <Field label="Contenu"><textarea required className="text-editor" value={content} onChange={e => setContent(e.target.value)} maxLength={200000}/></Field><button className="primary" disabled={busy}>{editing ? 'Enregistrer les changements' : tab === 'memory' ? 'Ajouter à la mémoire' : 'Importer & indexer'}</button><p className="small">Aucune clé, token ou donnée secrète dans la mémoire ou les documents. La recherche renvoie des passages réels, pas une réponse IA.</p>
    </form></section></div>
  </div>;
}
