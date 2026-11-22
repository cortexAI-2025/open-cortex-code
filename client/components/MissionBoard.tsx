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
  testPolicy?: string;
  summary?: string;
  plan?: { id: string; role: string; title: string; status: string }[];
  roles?: { role: string; summary: string }[];
  permissions?: { action: string; resources: string[]; decision: string }[];
}
interface ResumeResult { brief: string; estimatedTokens: number; submitted: false; truncated: boolean }
interface PublishState { currentBranch: string; remoteCertified: boolean; latest: { phase: string; branch: string; url: string | null; pushed: boolean; message?: string; remoteCertified: boolean } | null }
interface OrchestrationView {
  missionId: string;
  status: string;
  activeRole: string | null;
  tokens: { input: number; output: number };
  cost: { currency: string; amount: number } | null;
  pullRequestUrl: string | null;
  remoteCertified: boolean;
  tasks: { id: string; role: string; title: string; status: string; runs: number; result?: string }[];
  decisions: { role: string; text: string }[];
}
interface RuntimeView {
  missionId: string;
  status: string;
  concurrency: number;
  activeAgents: string[];
  parallelWaves: number;
  control: string;
  pullRequestUrl: string | null;
  remoteCertified: boolean;
  tokens?: { input: number; output: number };
  corrections?: string[];
  tasks: { id: string; key: string; role: string; agentId: string; title: string; status: string; dependsOn: string[]; runs: number; result?: string }[];
}

export function MissionBoard() {
  const { api } = useConnection();
  const { bootstrap } = useBootstrap();
  const { projectId, project } = useWorkspace();
  const { act, confirm } = useAppActions();
  const missions = useResource<MissionView[]>(api, projectId ? projectRoute(projectId, 'missions') : null, 8000);
  const publication = useResource<PublishState>(api, projectId ? projectRoute(projectId, 'git/publish') : null, 8000);
  const orchestrations = useResource<OrchestrationView[]>(api, projectId ? projectRoute(projectId, 'orchestrations') : null, 8000);
  const runtimes = useResource<RuntimeView[]>(api, projectId ? projectRoute(projectId, 'runtimes') : null, 8000);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [profile, setProfile] = useState('');
  const [claims, setClaims] = useState('agent-a src/app.ts\nagent-b src/lib.ts');
  const [commandId, setCommandId] = useState('');
  const [testCommand, setTestCommand] = useState('node --test');
  const [patchPath, setPatchPath] = useState('');
  const [patchBefore, setPatchBefore] = useState('');
  const [patchAfter, setPatchAfter] = useState('');
  const [testPolicy, setTestPolicy] = useState<'deny' | 'create' | 'adapt'>('deny');
  const [publishMessage, setPublishMessage] = useState('feat: correctif de mission');
  const [allowCommit, setAllowCommit] = useState(false);
  const [allowPush, setAllowPush] = useState(false);
  const [allowPullRequest, setAllowPullRequest] = useState(false);
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);

  const post = async (resource: string, body: Record<string, unknown>, question: string, detail: string) => {
    if (!api || !projectId || !await confirm(question, detail)) return;
    setBusy(true);
    await act(() => api.request(projectRoute(projectId, resource), 'POST', { ...body, confirm: true }));
    missions.refresh();
    orchestrations.refresh();
    runtimes.refresh();
    setBusy(false);
  };

  return <section className="form-panel mission-board"><div className="panel-title"><ShieldCheck size={16}/><h3>Mission avec preuve</h3></div>
    <p className="small">Le verdict reste local : test exit 0, sans conflit. Le mode Agent demande un correctif à OpenCode seulement si un modèle local ou une clé en mémoire est disponible. Sans cela la mission reste BLOCKED, sans correctif de remplacement. Un worktree n’est pas un sandbox OS.</p>
    <ErrorBox error={missions.error} retry={missions.refresh}/>{missions.loading && <Loading />}
    {missions.data?.map((mission) => {
      const last = mission.repairs?.at(-1);
      const profileName = bootstrap?.profiles.find((item) => item.id === mission.profileId)?.name;
      const touched = [...new Set(mission.repairs?.flatMap((item) => item.applied) ?? [])];
      const tokens = (mission.repairs ?? []).reduce((sum, item) => ({ input: sum.input + (item.tokens?.input ?? 0), output: sum.output + (item.tokens?.output ?? 0) }), { input: 0, output: 0 });
      const reviewer = mission.roles?.filter((item) => item.role === 'reviewer').at(-1);
      const active = [...(mission.roles ?? [])].reverse().find((item) => item.role === 'coder') ?? mission.roles?.at(-1);
      const publicationState = publication.data;
      const flow = orchestrations.data?.find((item) => item.missionId === mission.id);
      const runtime = runtimes.data?.find((item) => item.missionId === mission.id);
      return <article key={mission.id} className="agent-record"><div className="panel-title"><h3>{mission.title}</h3><span className="badge">{mission.verdict.label || mission.verdict.status}</span></div>
      <p>{mission.goal}</p>
      <p className="small">Verdict : {mission.verdict.label || (mission.verdict.complete ? 'PROVEN' : 'non prouvé')} · {mission.evidence.length} test(s) · tentative {last?.index ?? 0}/3 · politique tests {mission.testPolicy || 'deny'}</p>
      <p className="small">Agent actif : {active ? `${active.role}${last?.model ? ` · ${last.model}` : ''}` : 'aucun'}{last?.invoked ? ` · OpenCode${profileName ? ` · ${profileName}` : ''}${last.sessionId ? ` · ${last.sessionId}` : ''}` : ' · moteur non appelé'}</p>
      <p className="small">Fichiers modifiés : {touched.join(', ') || 'aucun'} · jetons mission {tokens.input}/{tokens.output}{last?.budgetMs ? ` · budget ${last.budgetMs} ms` : ''}</p>
      {mission.plan && mission.plan.length > 0 && <p className="small">Plan : {mission.plan.map((item) => `${item.role} ${item.status}`).join(' · ')}</p>}
      {mission.permissions && mission.permissions.length > 0 && <p className="small">Permissions : {mission.permissions.map((item) => `${item.decision} ${item.action} ${item.resources.join(', ')}`).join(' · ')}</p>}
      {reviewer && <p className="small">Reviewer : {reviewer.summary}</p>}
      <p className="small">Branche : {publicationState?.currentBranch || 'inconnue'} · publication : {publicationState?.latest ? `${publicationState.latest.phase} · poussée ${publicationState.latest.pushed ? 'oui' : 'non'} · distante ${publicationState.remoteCertified ? 'confirmée' : 'non'}` : 'aucune'}{publicationState?.latest?.message ? ` · ${publicationState.latest.message}` : ''}</p>
      {flow && <p className="small">Orchestration : {flow.status} · rôle actif {flow.activeRole || 'aucun'} · jetons {flow.tokens.input}/{flow.tokens.output} · coût {flow.cost ? `${flow.cost.amount} ${flow.cost.currency}` : 'tarif indisponible'} · distante {flow.remoteCertified ? 'confirmée' : 'non'}</p>}
      {flow && <p className="small">Plan : {flow.tasks.map((item) => `${item.role} ${item.status}×${item.runs}`).join(' · ')}</p>}
      {flow?.decisions.at(-1) && <p className="small">Dernière décision : {flow.decisions.at(-1)?.role} · {flow.decisions.at(-1)?.text}</p>}
      {flow?.pullRequestUrl && <p className="small"><a href={flow.pullRequestUrl}>{flow.pullRequestUrl}</a></p>}
      {runtime && <p className="small">Runtime : {runtime.status} · contrôle {runtime.control} · agents {runtime.activeAgents.join(', ') || 'aucun'} · concurrence {runtime.concurrency} · vagues parallèles {runtime.parallelWaves} · jetons {runtime.tokens?.input ?? 0}/{runtime.tokens?.output ?? 0} · coût tarif indisponible · distante {runtime.remoteCertified ? 'confirmée' : 'non'}</p>}
      {runtime && <p className="small">Tâches : {runtime.tasks.map((item) => `${item.role} ${item.status}×${item.runs}${item.dependsOn.length ? ` ← ${item.dependsOn.map((dep) => runtime.tasks.find((candidate) => candidate.id === dep)?.role || dep).join(', ')}` : ''}`).join(' · ')}</p>}
      {runtime?.corrections && runtime.corrections.length > 0 && <p className="small">Corrections : {runtime.corrections.join(' · ')}</p>}
      {runtime?.pullRequestUrl && <p className="small"><a href={runtime.pullRequestUrl}>{runtime.pullRequestUrl}</a></p>}
      {publicationState?.latest?.url && <p className="small"><a href={publicationState.latest.url}>{publicationState.latest.url}</a></p>}
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
      <label className="small">Politique de test <select aria-label="Politique de test" value={testPolicy} onChange={(event) => setTestPolicy(event.target.value as 'deny' | 'create' | 'adapt')}><option value="deny">Interdire les tests</option><option value="create">Créer de nouveaux tests</option><option value="adapt">Adapter sans affaiblir</option></select></label>
      <button className="primary" disabled={busy} onClick={() => void post(`missions/${mission.id}/orchestrate`, { command: testCommand, maxAttempts: 3, budgetMs: 180000, testPolicy }, 'Lancer l’orchestrateur ?', 'Plan et revue restent locaux. Un seul modèle code, au plus trois tentatives. La publication n’est pas incluse.')}>Orchestrer jusqu’à la revue</button>
      <button className="secondary" disabled={!api || !projectId} onClick={() => void post(`missions/${mission.id}/orchestrate/pause`, {}, 'Mettre l’orchestration en pause ?', 'La pause prend effet entre deux étapes. Le correctif déjà écrit n’est pas annulé.')}>Pause</button>
      <button className="secondary" disabled={busy} onClick={() => void post(`missions/${mission.id}/orchestrate/resume`, { command: testCommand, maxAttempts: 3, budgetMs: 180000, testPolicy }, 'Reprendre l’orchestration ?', 'Les étapes déjà validées ne sont pas refaites. Aucune publication implicite.')}>Reprendre</button>
      <button className="secondary" disabled={!api || !projectId} onClick={() => void post(`missions/${mission.id}/orchestrate/cancel`, {}, 'Annuler l’orchestration ?', 'Les étapes restantes sont annulées. Rien n’est publié.')}>Annuler</button>
      <button className="primary" disabled={busy} onClick={() => void post(`missions/${mission.id}/runtime`, { command: testCommand, maxAttempts: 3, budgetMs: 180000, testPolicy, concurrency: 2 }, 'Lancer le runtime multi-agents ?', 'Architecte, testeur et revue restent locaux. Un seul modèle code. Les tâches indépendantes peuvent avancer ensemble. Aucune publication implicite.')}>Runtime jusqu’à la revue</button>
      <button className="secondary" disabled={!api || !projectId} onClick={() => void post(`missions/${mission.id}/runtime/pause`, {}, 'Mettre le runtime en pause ?', 'La pause prend effet entre deux tâches. Elle ne coupe pas un appel modèle déjà lancé.')}>Pause du runtime</button>
      <button className="secondary" disabled={busy} onClick={() => void post(`missions/${mission.id}/runtime/resume`, { command: testCommand, maxAttempts: 3, budgetMs: 180000, testPolicy, concurrency: 2 }, 'Reprendre le runtime ?', 'Une tâche déjà validée n’est pas refaite sans invalidation. La publication n’est pas incluse.')}>Reprendre le runtime</button>
      <button className="secondary" disabled={!api || !projectId} onClick={() => void post(`missions/${mission.id}/runtime/cancel`, {}, 'Annuler le runtime ?', 'Les tâches restantes sont annulées. Rien n’est publié.')}>Annuler le runtime</button>
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); const grants: Record<string, true> = {}; if (allowCommit) grants.allowCommit = true; if (allowPush) grants.allowPush = true; if (allowPullRequest) grants.allowPullRequest = true; void post(`missions/${mission.id}/orchestrate/publish`, { message: publishMessage, ...grants }, 'Publier avec ces permissions seulement ?', 'Chaque case est une autorisation distincte. Rien n’est fusionné et aucun push forcé n’est émis.'); }}><input aria-label="Message de publication" value={publishMessage} onChange={(event) => setPublishMessage(event.target.value)} required/><label className="small"><input type="checkbox" checked={allowCommit} onChange={(event) => setAllowCommit(event.target.checked)}/> Commit</label><label className="small"><input type="checkbox" checked={allowPush} onChange={(event) => setAllowPush(event.target.checked)}/> Push</label><label className="small"><input type="checkbox" checked={allowPullRequest} onChange={(event) => setAllowPullRequest(event.target.checked)}/> Pull request</label><button className="secondary" type="submit" disabled={busy}>Valider la publication</button><button className="secondary" type="button" disabled={busy} onClick={() => { const grants: Record<string, true> = {}; if (allowCommit) grants.allowCommit = true; if (allowPush) grants.allowPush = true; if (allowPullRequest) grants.allowPullRequest = true; void post(`missions/${mission.id}/runtime/publish`, { message: publishMessage, ...grants }, 'Publier le runtime avec ces permissions seulement ?', 'allowCommit, allowPush et allowPullRequest restent distincts. Rien n’est fusionné et aucun push forcé n’est émis.'); }}>Publier le runtime</button></form>
      <button className="primary" disabled={busy} onClick={() => void post(`missions/${mission.id}/agent`, { command: testCommand, maxAttempts: 3, budgetMs: 180000, testPolicy }, 'Lancer le mode Agent OpenCode ?', 'Aucun fragment avant/après n’est envoyé. La branche courante ne doit pas être main. OpenCode peut modifier le périmètre revendiqué, avec une permission once. Les tests existants restent protégés selon la politique choisie. Trois tentatives au plus, puis les tests du connecteur tranchent. Sans modèle joignable, la mission reste BLOCKED.')}>Corriger avec OpenCode (mode Agent)</button>
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); const patches = patchPath && patchBefore ? [{ path: patchPath, before: patchBefore, after: patchAfter }] : []; void post(`missions/${mission.id}/repair`, { command: testCommand, maxAttempts: 3, patches }, 'Appliquer un correctif manuel hors moteur ?', 'Ce formulaire n’appelle pas OpenCode. Il reste un filet de secours. Un correctif de test est refusé.'); }}><input aria-label="Commande de test" value={testCommand} onChange={(event) => setTestCommand(event.target.value)} required/><input aria-label="Fichier du correctif" value={patchPath} onChange={(event) => setPatchPath(event.target.value)} placeholder="src/fichier.js"/><input aria-label="Fragment à remplacer" value={patchBefore} onChange={(event) => setPatchBefore(event.target.value)} placeholder="fragment exact"/><input aria-label="Fragment corrigé" value={patchAfter} onChange={(event) => setPatchAfter(event.target.value)} placeholder="remplacement"/><button className="secondary" type="submit" disabled={busy}>Correctif manuel hors moteur</button></form>
    </article>;
    })}
    {brief && <pre className="result-json">{brief}</pre>}
    <form onSubmit={(event) => { event.preventDefault(); void post('missions', { title, goal, profileId: profile }, 'Ouvrir cette mission ?', 'Aucun fichier n’est modifié et aucun fournisseur n’est contacté. Le profil sert seulement au transfert de contexte.'); }}><h3>Nouvelle mission</h3><Field label="Titre"><input required value={title} onChange={(event) => setTitle(event.target.value)}/></Field><Field label="Objectif"><textarea required className="text-editor" value={goal} onChange={(event) => setGoal(event.target.value)}/></Field><Field label="Profil"><select required value={profile} onChange={(event) => setProfile(event.target.value)}><option value="">Choisir</option>{bootstrap?.profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><button className="primary" disabled={busy || !project?.trusted || !profile}>Ouvrir la mission</button></form>
  </section>;
}
