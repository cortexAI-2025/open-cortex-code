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
  verdict: { complete: boolean; status: string; label?: string; reasons: string[] };
  conflicts: { path: string; agents: string[] }[];
  evidence: { command: string; exitCode: number | null; timedOut?: boolean; truncated?: boolean }[];
  repairs?: { index: number; exitCode: number | null; diagnosis: string; applied: string[]; stopped?: string; model?: string; sessionId?: string; invoked?: boolean; budgetMs?: number; tokens?: { input: number; output: number } }[];
  profileId?: string;
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
  const [testCommand, setTestCommand] = useState('node --test');
  const [patchPath, setPatchPath] = useState('');
  const [patchBefore, setPatchBefore] = useState('');
  const [patchAfter, setPatchAfter] = useState('');
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
    <p className="small">Le verdict reste local : test exit 0, sans conflit. Le mode Agent demande un correctif à OpenCode seulement si un modèle local ou une clé en mémoire est disponible. Sans cela la mission reste BLOCKED, sans correctif de remplacement. Un worktree n’est pas un sandbox OS.</p>
    <ErrorBox error={missions.error} retry={missions.refresh}/>{missions.loading && <Loading />}
    {missions.data?.map((mission) => {
      const last = mission.repairs?.at(-1);
      const profileName = bootstrap?.profiles.find((item) => item.id === mission.profileId)?.name;
      const touched = [...new Set(mission.repairs?.flatMap((item) => item.applied) ?? [])];
      return <article key={mission.id} className="agent-record"><div className="panel-title"><h3>{mission.title}</h3><span className="badge">{mission.verdict.label || mission.verdict.status}</span></div>
      <p>{mission.goal}</p>
      <p className="small">Verdict : {mission.verdict.label || (mission.verdict.complete ? 'PROVEN' : 'non prouvé')} · {mission.evidence.length} test(s) · tentative {last?.index ?? 0}/3</p>
      <p className="small">Agent : {last?.invoked ? `OpenCode mode Agent${last.model ? ` · ${last.model}` : ''}${profileName ? ` · profil ${profileName}` : ''}${last.sessionId ? ` · session ${last.sessionId}` : ''}` : 'moteur non appelé'}</p>
      <p className="small">Fichiers modifiés par la boucle : {touched.join(', ') || 'aucun'}{last?.budgetMs ? ` · budget ${last.budgetMs} ms` : ''}{last?.tokens ? ` · tokens ${last.tokens.input}/${last.tokens.output}` : ''}</p>
      <ul className="delivery-limits">{mission.verdict.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      {mission.evidence.map((item, index) => <p className="small" key={`${item.command}-${index}`}>Test {index + 1} : exit {item.exitCode ?? 'absent'} · {item.command}</p>)}
      {mission.repairs?.map((repair, index) => <p className="small" key={`${repair.index}-${index}`}>Tentative {repair.index}/3 : exit {repair.exitCode ?? 'absent'} · {repair.stopped || 'correctif non encore revérifié'}{repair.applied.length ? ` · ${repair.applied.join(', ')}` : ''}</p>)}
      {last && last.stopped !== 'passed' && <p className="small">Dernier diagnostic : {last.diagnosis}</p>}
      <p className="small">{mission.conflicts.length > 0 ? `Conflits : ${mission.conflicts.map((conflict) => `${conflict.path} (${conflict.agents.join(', ')})`).join(' · ')}. Aucune fusion.` : 'Aucun conflit de fichiers.'}</p>
      <div className="button-row">{mission.steps.filter((step) => step.kind !== 'test').map((step) => <button key={step.id} className="secondary" disabled={busy || step.status === 'done'} onClick={() => void post(`missions/${mission.id}/steps`, { stepId: step.id, status: 'done' }, `Marquer « ${step.title} » comme faite ?`, 'Cela n’exécute pas de test et ne prouve pas la mission à lui seul.')}>{step.title} · {step.status}</button>)}</div>
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); const parsed = claims.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => { const [agentId, ...paths] = line.split(/\s+/); return { agentId: agentId || 'agent', paths }; }); void post(`missions/${mission.id}/claims`, { claims: parsed }, 'Enregistrer ces revendications ?', 'Un même fichier ou un dossier parent partagé entre deux agents bloque la mission. Aucune fusion n’est lancée.'); }}><textarea className="text-editor" aria-label="Revendications de fichiers" value={claims} onChange={(event) => setClaims(event.target.value)}/><button className="secondary" disabled={busy}>Contrôler les conflits</button></form>
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); void post(`missions/${mission.id}/evidence`, { commandId }, 'Joindre cette commande comme preuve ?', 'Seule une commande déjà exécutée avec kind:test est acceptée. Un exit non nul laisse la mission ouverte.'); }}><input aria-label="Identifiant de commande de test" value={commandId} onChange={(event) => setCommandId(event.target.value)} placeholder="Identifiant de commande kind:test" required/><button className="secondary" disabled={busy}>Joindre la preuve</button></form>
      <button className="secondary" disabled={busy} onClick={async () => { if (!api) return; setBusy(true); const result = await act(() => api.request<ResumeResult>(projectRoute(projectId, `missions/${mission.id}/resume`), 'POST', { budgetTokens: 1200 })); if (result) setBrief(result.brief); missions.refresh(); setBusy(false); }}>Préparer un brief de reprise (sans appel modèle)</button>
      <button className="secondary" disabled={busy} onClick={() => void post(`missions/${mission.id}/claims/sync`, {}, 'Déduire les revendications des worktrees ?', 'Les modifications, ajouts, suppressions et renommages Git de chaque agent remplacent les revendications. Un conflit bloque la preuve. Aucune fusion.')}>Synchroniser les fichiers depuis les worktrees</button>
      <button className="primary" disabled={busy} onClick={() => void post(`missions/${mission.id}/agent`, { command: testCommand, maxAttempts: 3, budgetMs: 180000 }, 'Lancer le mode Agent OpenCode ?', 'Aucun fragment avant/après n’est envoyé. OpenCode peut modifier seulement les fichiers revendiqués, avec une permission once. Trois tentatives, puis les tests du connecteur tranchent. Sans modèle joignable, la mission reste BLOCKED.')}>Corriger avec OpenCode (mode Agent)</button>
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); const patches = patchPath && patchBefore ? [{ path: patchPath, before: patchBefore, after: patchAfter }] : []; void post(`missions/${mission.id}/repair`, { command: testCommand, maxAttempts: 3, patches }, 'Appliquer un correctif manuel hors moteur ?', 'Ce formulaire n’appelle pas OpenCode. Il reste un filet de secours. Un correctif de test est refusé.'); }}><input aria-label="Commande de test" value={testCommand} onChange={(event) => setTestCommand(event.target.value)} required/><input aria-label="Fichier du correctif" value={patchPath} onChange={(event) => setPatchPath(event.target.value)} placeholder="src/fichier.js"/><input aria-label="Fragment à remplacer" value={patchBefore} onChange={(event) => setPatchBefore(event.target.value)} placeholder="fragment exact"/><input aria-label="Fragment corrigé" value={patchAfter} onChange={(event) => setPatchAfter(event.target.value)} placeholder="remplacement"/><button className="secondary" type="submit" disabled={busy}>Correctif manuel hors moteur</button></form>
    </article>;
    })}
    {brief && <pre className="result-json">{brief}</pre>}
    <form onSubmit={(event) => { event.preventDefault(); void post('missions', { title, goal, profileId: profile }, 'Ouvrir cette mission ?', 'Aucun fichier n’est modifié et aucun fournisseur n’est contacté. Le profil sert seulement au transfert de contexte.'); }}><h3>Nouvelle mission</h3><Field label="Titre"><input required value={title} onChange={(event) => setTitle(event.target.value)}/></Field><Field label="Objectif"><textarea required className="text-editor" value={goal} onChange={(event) => setGoal(event.target.value)}/></Field><Field label="Profil"><select required value={profile} onChange={(event) => setProfile(event.target.value)}><option value="">Choisir</option>{bootstrap?.profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><button className="primary" disabled={busy || !project?.trusted || !profile}>Ouvrir la mission</button></form>
  </section>;
}
