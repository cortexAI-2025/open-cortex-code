import { useState } from 'react';
import { WandSparkles, Plus, Download, Trash2 } from 'lucide-react';
import type { CortexSession, FileContent, Skill } from '../../shared/contracts';
import { RequestError, projectRoute, sha256, useResource } from '../api';
import { useApp } from '../state';
import { Empty, ErrorBox, Field, Loading, SectionHeading } from '../components/ui';
export function Skills() {
    const { api, projectId, profileId, act, confirm, setSession, setView } = useApp();
    const skills = useResource<Skill[]>(api, projectId ? projectRoute(projectId, 'skills') : null);
    const [selected, setSelected] = useState<Skill | null>(null);
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [content, setContent] = useState('');
    const [request, setRequest] = useState('');
    const [busy, setBusy] = useState(false);
    const [conflict, setConflict] = useState<{
        skill: Skill;
        hash: string;
        current: string;
    } | null>(null);
    const reset = () => { setSelected(null); setName(''); setDescription(''); setContent(''); setConflict(null); };
    const toggleAssociation = async (skill: Skill) => {
        if (!api || !await confirm(skill.enabled ? 'Retirer ce Skill du projet ?' : 'Associer ce Skill au projet ?', skill.enabled ? 'Les prochains prompts ne transmettront plus ces instructions.' : 'Ces instructions locales seront transmises au modèle sélectionné lors des prochains prompts. Les permissions des outils ne changent pas.')) return;
        setBusy(true);
        await act(() => api.request(projectRoute(projectId, `skills/${skill.id}/association`), 'POST', { enabled: !skill.enabled, confirm: true }));
        skills.refresh();
        setBusy(false);
    };
    const exportSkill = async (skill: Skill, expectedHash?: string) => {
        if (!api || !await confirm('Exporter ce Skill vers OpenCode ?', `.opencode/skills/${skill.name}/SKILL.md sera écrit sur votre appareil. ${expectedHash ? 'Vous avez examiné le fichier existant ; le remplacement sera refusé s’il a changé.' : 'Un fichier existant ne sera jamais écrasé sans nouvel examen.'}`))
            return;
        setBusy(true);
        await act(async () => {
            try {
                await api.request(projectRoute(projectId, `skills/${encodeURIComponent(skill.id)}/export`), 'POST', { confirm: true, ...(expectedHash ? { expectedHash } : {}) });
                setConflict(null);
            }
            catch (error) {
                if (error instanceof RequestError && error.payload.code === 'FILE_CONFLICT' && typeof error.payload.currentHash === 'string') {
                    const file = await api.request<FileContent>(`${projectRoute(projectId, 'file')}?path=${encodeURIComponent(`.opencode/skills/${skill.name}/SKILL.md`)}`);
                    setConflict({ skill, hash: file.hash, current: file.content });
                    return;
                }
                throw error;
            }
        });
        setBusy(false);
    };
    return <div className="page-scroll management-page"><SectionHeading index="07" title="Skills" detail="Instructions locales associées au projet sur consentement, sans permissions supplémentaires." action={<button className="secondary" onClick={reset}><Plus size={14}/>Nouveau Skill</button>}/><ErrorBox error={skills.error} retry={skills.refresh}/>{skills.loading && <Loading />}
    <div className="split-management"><section><div className="item-list">{skills.data?.map(skill => <div className="skill-row" key={skill.id}><button className={selected?.id === skill.id ? 'selected' : ''} onClick={() => { setSelected(skill); setName(skill.name); setDescription(skill.description); setContent(skill.content); }}><strong>{skill.name}{skill.enabled ? ' · Associé' : ''}</strong><p>{skill.description}</p></button><div className="button-row"><button className="secondary" disabled={busy} onClick={() => void toggleAssociation(skill)}>{skill.enabled ? 'Retirer du projet' : 'Associer au projet'}</button><button className="secondary" disabled={busy} onClick={() => void exportSkill(skill)}><Download size={13}/>Exporter</button><button className="icon-button" title="Supprimer le Skill de la bibliothèque" aria-label={`Supprimer ${skill.name}`} disabled={busy} onClick={async () => { if (!api || !await confirm('Supprimer ce Skill ?', 'La bibliothèque locale sera modifiée. Un fichier déjà exporté sur disque est conservé.'))
        return; await act(() => api.request(projectRoute(projectId, `skills/${skill.id}`), 'DELETE', { confirm: true })); skills.refresh(); if (selected?.id === skill.id)
        reset(); }}><Trash2 size={13}/></button></div></div>)}</div>{skills.data?.length === 0 && <Empty title="Aucun Skill local" detail="Créez vos instructions spécialisées. Aucun Skill factice n’est préinstallé."/>}
      <section className="form-panel generation-panel"><div className="panel-title"><WandSparkles size={17}/><h3>Proposer avec votre modèle</h3></div><form onSubmit={async (e) => { e.preventDefault(); if (!api || !profileId || !await confirm('Demander une proposition de Skill ?', 'Une vraie session Ask sera créée avec le profil sélectionné. Aucun fichier ne sera écrit automatiquement. Copiez et validez la proposition avant enregistrement.'))
        return; setBusy(true); const session = await act(() => api.request<CortexSession>(projectRoute(projectId, 'skills/generate'), 'POST', { request, profileId })); if (session) {
        setSession(session);
        setView('editor');
    } setBusy(false); }}><textarea value={request} onChange={e => setRequest(e.target.value)} required placeholder="Décrivez les conventions, contrôles et résultats attendus…" aria-label="Demande de génération Skill"/><button className="secondary" disabled={!profileId || busy}>Créer une session de génération</button><p className="small">Profil BYOK requis. La proposition apparaît dans l’agent et n’est pas présentée comme un Skill terminé.</p></form></section>
    </section><section className="form-panel"><h3>{selected ? 'Modifier le Skill' : 'Éditeur de Skill'}</h3><form onSubmit={async (e) => { e.preventDefault(); if (!api)
        return; if (selected && !await confirm('Enregistrer ce Skill ?', 'Le contenu de la bibliothèque sera modifié après contrôle du hash original. L’export sur disque reste une action séparée.'))
        return; setBusy(true); const result = await act(async () => api.request<Skill>(projectRoute(projectId, selected ? `skills/${selected.id}` : 'skills'), selected ? 'PUT' : 'POST', { name, description, content, ...(selected ? { confirm: true, expectedHash: await sha256(selected.content) } : {}) }), 'Skill enregistré dans la bibliothèque locale.'); if (result) {
        setSelected(result);
        setContent(result.content);
        skills.refresh();
    } setBusy(false); }}>
      <Field label="Nom (slug minuscules)"><input required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={64} value={name} onChange={e => setName(e.target.value)} placeholder="audit-securite"/></Field><Field label="Description sur une ligne"><input required maxLength={1024} value={description} onChange={e => setDescription(e.target.value)}/></Field><Field label="Instructions Markdown" hint="Si présent, le frontmatter doit correspondre exactement au nom et à la description."><textarea required className="text-editor mono" value={content} onChange={e => setContent(e.target.value)} maxLength={200000}/></Field><button className="primary" disabled={busy}>Enregistrer dans la bibliothèque</button>
    </form></section></div>
    {conflict && <section className="form-panel export-conflict"><h3>Le fichier existe : examen requis</h3><p className="mono">.opencode/skills/{conflict.skill.name}/SKILL.md</p><div className="split-management"><div><h4>Contenu actuel sur disque</h4><pre className="result-json">{conflict.current}</pre></div><div><h4>Skill proposé</h4><pre className="result-json">{conflict.skill.content}</pre></div></div><div className="button-row"><button className="secondary" onClick={() => setConflict(null)}>Conserver le fichier existant</button><button className="danger" disabled={busy} onClick={() => void exportSkill(conflict.skill, conflict.hash)}>Remplacer après examen avec hash</button></div></section>}
  </div>;
}
