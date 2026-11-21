import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { projectRoute, useResource } from '../api';
import { useConnection, useBootstrap, useWorkspace, useAppActions } from '../state';
import { ErrorBox, Field, Loading } from './ui';

interface MissionStep { id: string; title: string; kind: string; status: string; required: boolean }
interface MissionView {
  id: string;
  title: string;
  goal: string;
  status: string;
  suggestedBranch?: string;
  steps: MissionStep[];
  verdict: { complete: boolean; status: string; reasons: string[] };
  conflicts: { path: string; agents: string[] }[];
  evidence: { command: string; exitCode: number | null }[];
}
interface ResumeResult { brief: string; estimatedTokens: number; submitted: false; truncated: boolean }

export function MissionBoard() {
  const { api } = useConnection();
  const { bootstrap } = useBootstrap();
  const { projectId, project } = useWorkspace();
  const { act, confirm } = useAppActions();
  const missions = useResource<MissionView[]>(api, projectId ? projectRoute(projectId, 'missions') : null, 8000);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [profile, setProfile] = useState('');
  const [claims, setClaims] = useState('agent-a src/app.ts\nagent-b src/lib.ts');
  const [commandId, setCommandId] = useState('');
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);

  const post = async (resource: string, body: Record<string, unknown>, question: string, detail: string) => {
    if (!api || !projectId || !await confirm(question, detail)) return;
    setBusy(true);
    await act(() => api.request(projectRoute(projectId, resource), 'POST', { ...body, confirm: true }));
    missions.refresh();
    setBusy(false);
  };

  return <section className="form-panel mission-board"><div className="panel-title"><ShieldCheck size={16}/><h3>Mission avec preuve</h3></div>
    <p className="small">Le connecteur planifie localement, détecte les fichiers en conflit et refuse l’état « terminé » sans un test kind:test exit 0. Aucun modèle n’est appelé pour ce verdict.</p>
    <ErrorBox error={missions.error} retry={missions.refresh}/>{missions.loading && <Loading />}
    {missions.data?.map((mission) => <article key={mission.id} className="agent-record"><div className="panel-title"><h3>{mission.title}</h3><span className="badge">{mission.verdict.status}</span></div>
      <p>{mission.goal}</p>
      <ul className="delivery-limits">{mission.verdict.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      {mission.conflicts.length > 0 && <p className="small">Conflits : {mission.conflicts.map((conflict) => `${conflict.path} (${conflict.agents.join(', ')})`).join(' · ')}</p>}
      <div className="button-row">{mission.steps.filter((step) => step.kind !== 'test').map((step) => <button key={step.id} className="secondary" disabled={busy || step.status === 'done'} onClick={() => void post(`missions/${mission.id}/steps`, { stepId: step.id, status: 'done' }, `Marquer « ${step.title} » comme faite ?`, 'Cela n’exécute pas de test et ne prouve pas la mission à lui seul.')}>{step.title} · {step.status}</button>)}</div>
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); const parsed = claims.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => { const [agentId, ...paths] = line.split(/\s+/); return { agentId: agentId || 'agent', paths }; }); void post(`missions/${mission.id}/claims`, { claims: parsed }, 'Enregistrer ces revendications ?', 'Un même fichier ou un dossier parent partagé entre deux agents bloque la mission. Aucune fusion n’est lancée.'); }}><textarea className="text-editor" aria-label="Revendications de fichiers" value={claims} onChange={(event) => setClaims(event.target.value)}/><button className="secondary" disabled={busy}>Contrôler les conflits</button></form>
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); void post(`missions/${mission.id}/evidence`, { commandId }, 'Joindre cette commande comme preuve ?', 'Seule une commande déjà exécutée avec kind:test est acceptée. Un exit non nul laisse la mission ouverte.'); }}><input aria-label="Identifiant de commande de test" value={commandId} onChange={(event) => setCommandId(event.target.value)} placeholder="Identifiant de commande kind:test" required/><button className="secondary" disabled={busy}>Joindre la preuve</button></form>
      <button className="secondary" disabled={busy} onClick={async () => { if (!api) return; setBusy(true); const result = await act(() => api.request<ResumeResult>(projectRoute(projectId, `missions/${mission.id}/resume`), 'POST', { budgetTokens: 1200 })); if (result) setBrief(result.brief); setBusy(false); }}>Préparer un brief de reprise (sans appel modèle)</button>
    </article>)}
    {brief && <pre className="result-json">{brief}</pre>}
    <form onSubmit={(event) => { event.preventDefault(); void post('missions', { title, goal, profileId: profile }, 'Ouvrir cette mission ?', 'Aucun fichier n’est modifié et aucun fournisseur n’est contacté. Le profil sert seulement au transfert de contexte.'); }}><h3>Nouvelle mission</h3><Field label="Titre"><input required value={title} onChange={(event) => setTitle(event.target.value)}/></Field><Field label="Objectif"><textarea required className="text-editor" value={goal} onChange={(event) => setGoal(event.target.value)}/></Field><Field label="Profil"><select required value={profile} onChange={(event) => setProfile(event.target.value)}><option value="">Choisir</option>{bootstrap?.profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><button className="primary" disabled={busy || !project?.trusted || !profile}>Ouvrir la mission</button></form>
  </section>;
}
