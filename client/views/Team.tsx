import { useRef, useState } from 'react';
import { Bot, CheckCircle2, GitBranch, Link2, Play, RefreshCw, ShieldAlert, Users, XCircle } from 'lucide-react';
import type { CtoAgentInfo, CtoMissionLink, CtoMissionView, CtoTeam } from '../../shared/contracts';
import { dateLabel, projectRoute, useResource } from '../api';
import { useAppActions, useConnection, useWorkspace } from '../state';
import { Empty, ErrorBox, Field, Loading, SectionHeading } from '../components/ui';
import { HumanDelegations } from '../components/HumanDelegations';

const money = (value: number | undefined) => `${(value ?? 0).toFixed(3)} USD`;
const connectionLabel: Record<CtoTeam['supervisor']['connection'], string> = { connected: 'CONNECTÉ', unreachable: 'INJOIGNABLE', unauthorized: 'JETON REFUSÉ', not_configured: 'NON CONFIGURÉ' };
const approvalLabel: Record<string, string> = { mission: 'Lancement de la mission', architecture: 'Plan de l’architecte', completion: 'Livraison finale' };
const approvalDetail: Record<string, string> = {
    mission: 'Le CTO IA pourra déléguer à l’architecte, qui lira le dépôt (lecture seule) et dépensera des crédits modèle dans le budget plafonné.',
    architecture: 'Le backend pourra écrire du code dans un worktree isolé du dépôt, dans le périmètre de la mission, puis le CTO exécutera les tests et la revue.',
    completion: 'Marque la mission comme livrée. Aucun push, aucune PR distante, aucune fusion et aucun déploiement ne sont déclenchés par cette décision.',
};
const finished = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);

function AgentCard({ agent, missions }: { agent: CtoAgentInfo; missions: CtoMissionLink[] }) {
    const live = missions.filter(m => !finished(m.status)).length;
    return <article className="form-panel team-agent"><div className="panel-title"><Bot size={16}/><h3>{agent.label}</h3><span className={`badge ${agent.state === 'idle' ? 'positive' : ''}`}>{agent.state === 'unknown' ? 'ÉTAT INCONNU' : agent.state === 'busy' ? 'EN TÂCHE' : 'DISPONIBLE'}</span></div>
      <p className="small">{agent.readOnly ? 'Lecture seule' : 'Écriture dans son worktree'} · {agent.maxBudgetUsd === null ? 'plafond inconnu' : `plafond ${agent.maxBudgetUsd} USD / tâche`}</p>
      <p className="small">{agent.capabilities.length ? agent.capabilities.join(', ') : 'Capacités non communiquées (CTO non joint).'}</p>
      {agent.runningTasks.length > 0 && <code className="team-code">{agent.runningTasks.length} tâche(s) en cours</code>}
      {live > 0 && agent.state !== 'unknown' && <small>{live} mission(s) active(s) dans ce projet</small>}</article>;
}

function MissionDetail({ projectId, missionId, onChanged }: { projectId: string; missionId: string; onChanged: () => void }) {
    const { api } = useConnection();
    const { act, confirm } = useAppActions();
    const view = useResource<CtoMissionView>(api, projectRoute(projectId, `cto/missions/${encodeURIComponent(missionId)}`), 4000);
    const [note, setNote] = useState('');
    const data = view.data;
    const link = data?.link;
    const post = async (action: string, body: Record<string, unknown>, success: string) => {
        if (!api) return;
        await act(() => api.request(projectRoute(projectId, `cto/missions/${encodeURIComponent(missionId)}/${action}`), 'POST', { ...body, confirm: true }), success);
        view.refresh(); onChanged();
    };
    const decide = async (kind: string, decision: 'approve' | 'reject') => {
        const ok = await confirm(`${decision === 'approve' ? 'Approuver' : 'Refuser'} : ${approvalLabel[kind] ?? kind}`, decision === 'approve' ? approvalDetail[kind] ?? 'Décision explicite requise.' : 'Le refus annule la mission côté CTO IA. Les résultats déjà obtenus sont conservés.');
        if (ok) await post('approvals', { kind, decision, note: note || undefined }, decision === 'approve' ? 'Approbation transmise au CTO IA.' : 'Refus transmis : mission annulée.');
    };
    if (view.loading && !data) return <Loading />;
    if (!link || !data) return <ErrorBox error={view.error} retry={view.refresh}/>;
    const report = data.report;
    const budgetPct = Math.min(100, Math.round((link.spentUsd / Math.max(link.budgetUsd, 0.0001)) * 100));
    return <section className="form-panel team-detail">
      <div className="panel-title"><Users size={16}/><h3>{link.objective.slice(0, 90)}</h3><span className="badge">{link.localState === 'submitting' ? 'TRANSMISSION EN ATTENTE' : link.status.toUpperCase()}</span></div>
      {link.stale && <ErrorBox error={`État du CTO IA périmé (dernière synchro ${dateLabel(link.syncedAt)}) : ${link.lastError?.message ?? 'injoignable'}`} retry={view.refresh}/>}
      {link.localState === 'submitting' && !link.stale && <div className="info-note"><Link2 size={17}/><span>La mission est enregistrée localement mais pas confirmée par le CTO IA. « Reprendre » la retransmet sans créer de doublon.</span></div>}
      <p className="small">{link.repo} · {link.id}{link.ctoMissionId ? ` → CTO ${link.ctoMissionId}` : ''}</p>
      <div className="team-budget" aria-label="Budget"><div style={{ width: `${budgetPct}%` }}/></div>
      <p className="small">Coût {money(link.spentUsd)} sur {money(link.budgetUsd)}{link.estimatedUsd > 0 ? ` (dont ${money(link.estimatedUsd)} estimés après interruption)` : ''} · périmètre : {link.scope.length ? link.scope.join(', ') : 'non restreint'}</p>

      {link.blockers.length > 0 && <div className="error-box" role="alert"><ShieldAlert size={16}/><span><strong>Blocage :</strong> {link.blockers.join(' · ')}</span></div>}

      {link.pendingApprovals.length > 0 && <div className="permission-card"><div><ShieldAlert size={15}/> Validation humaine requise</div>
        {link.pendingApprovals.map(kind => <div key={kind}><p><strong>{approvalLabel[kind] ?? kind}</strong><br/>{approvalDetail[kind]}</p>
          <Field label="Note (facultatif)"><input value={note} maxLength={500} onChange={e => setNote(e.target.value)}/></Field>
          <div className="button-row"><button className="primary" onClick={() => void decide(kind, 'approve')}><CheckCircle2 size={14}/>Approuver</button><button className="danger" onClick={() => void decide(kind, 'reject')}><XCircle size={14}/>Refuser</button></div></div>)}</div>}

      <h4>Tâches confiées aux agents</h4>
      <table className="team-table"><thead><tr><th>Agent</th><th>État</th><th>Essais</th><th>Corrections</th><th>Coût</th></tr></thead><tbody>
        {data.tasks.map(t => <tr key={t.id}><td>{t.role}</td><td>{t.status}</td><td>{t.attempts}</td><td>{t.corrections}</td><td>{money(report?.costByRole[t.role])}</td></tr>)}
        {data.tasks.length === 0 && <tr><td colSpan={5}>Aucune tâche : mission non encore acceptée par le CTO IA.</td></tr>}</tbody></table>

      <h4>Tests et revues (exécutés par le CTO, pas par les agents)</h4>
      <p className="small">Tests du projet : {report?.tests ? `${report.tests.passed} réussis, ${report.tests.failed} échoués` : 'aucun résultat vérifié'} · tests d’acceptation : {report?.acceptanceTests ? `${report.acceptanceTests.passed} réussis, ${report.acceptanceTests.failed} échoués` : 'non fournis ou non exécutés'} · corrections demandées : {report?.corrections ?? 0}</p>
      {report?.reviews.map(r => <div key={r.role} className="team-review"><span className={`badge ${r.verdict === 'pass' ? 'positive' : ''}`}>{r.role.toUpperCase()} · {r.verdict}</span>{r.findings.map((f, i) => <small key={i}> [{f.severity}] {f.file} : {f.issue}</small>)}</div>)}
      {report && report.reviews.length === 0 && <p className="small">Revues indépendantes QA et Sécurité : pas encore rendues.</p>}

      <h4>Preuves Git</h4>
      {report?.git ? <div className="agent-worktree"><code><GitBranch size={11}/> {report.git.branch}</code><code>commit {report.git.commit}{report.git.baseCommit ? ` (base ${report.git.baseCommit.slice(0, 8)})` : ''}</code>{report.git.files.map(f => <code key={f}>{f}</code>)}<pre className="result-json">{report.git.diffstat}</pre><small>Branche locale du CTO. Poussée : non · fusionnée : non. Publication, PR distante et fusion restent à votre décision.</small></div> : <p className="small">Aucun commit vérifié pour l’instant.</p>}
      {report && report.pullRequestBody && report.git && <details><summary>Rapport de PR préparé par le CTO</summary><pre className="result-json">{report.pullRequestBody}</pre></details>}

      <h4>Événements de mission</h4>
      <div className="history-timeline">{[...data.events].reverse().slice(0, 40).map(e => <article key={e.id}><div className="timeline-marker"/><header><span className="badge">{e.type}</span><time>{dateLabel(e.at)}</time></header><p>{e.actor}{Object.keys(e.detail).length ? ` · ${JSON.stringify(e.detail).slice(0, 220)}` : ''}</p></article>)}</div>

      <div className="button-row team-actions">
        <button className="secondary" onClick={view.refresh}><RefreshCw size={14}/>Actualiser</button>
        {!finished(link.status) && link.localState !== 'cancelled' && <button className="secondary" onClick={async () => { if (await confirm('Reprendre la mission ?', 'Réconcilie avec le CTO IA et relance uniquement ce qui est bloqué ou en attente. Une mission déjà acceptée ou en cours n’est jamais recréée.')) await post('resume', {}, 'Reprise demandée.'); }}><Play size={14}/>Reprendre</button>}
        {!finished(link.status) && link.localState !== 'cancelled' && <button className="danger" onClick={async () => { if (await confirm('Annuler la mission ?', 'Le CTO IA arrête les agents en cours et libère les worktrees. Les résultats et coûts déjà obtenus sont conservés.')) await post('cancel', {}, 'Mission annulée.'); }}><XCircle size={14}/>Annuler</button>}
      </div></section>;
}

export function Team() {
    const { api } = useConnection();
    const { projectId, project } = useWorkspace();
    const { act, confirm } = useAppActions();
    const team = useResource<CtoTeam>(api, '/cto/team', 6000);
    const missions = useResource<CtoMissionLink[]>(api, projectId ? projectRoute(projectId, 'cto/missions') : null, 6000);
    const [selected, setSelected] = useState('');
    const [objective, setObjective] = useState('');
    const [repo, setRepo] = useState('');
    const [budget, setBudget] = useState('3');
    const [criteria, setCriteria] = useState('');
    const [scope, setScope] = useState('');
    const [accName, setAccName] = useState('acceptance.test.js');
    const [accTests, setAccTests] = useState('');
    const [busy, setBusy] = useState(false);
    const key = useRef(crypto.randomUUID());
    const sup = team.data?.supervisor;
    const runtime = team.data?.runtime;
    const list = missions.data ?? [];
    const connected = sup?.connection === 'connected';
    const blocked = runtime?.status !== 'READY';
    const readOnly = sup?.accessRole === 'viewer';

    const register = async () => {
        if (!api) return;
        if (!await confirm('Enregistrer le CTO IA comme superviseur ?', 'Open Cortex Code lui confiera des missions et affichera ses agents. Aucune clé n’est transmise au navigateur ni aux agents ; l’authentification serveur à serveur reste dans le connecteur.')) return;
        await act(() => api.request('/cto/register', 'POST', { confirm: true }), 'CTO IA enregistré comme agent superviseur.');
        team.refresh();
    };
    const create = async () => {
        if (!api || !projectId) return;
        if (!await confirm('Transmettre la mission au CTO IA ?', `Budget plafonné à ${budget} USD de crédits modèle. Le CTO demandera votre validation avant chaque étape sensible. Aucun push, aucune fusion, aucun déploiement.`)) return;
        setBusy(true);
        const created = await act(() => api.request<CtoMissionView>(projectRoute(projectId, 'cto/missions'), 'POST', {
            idempotencyKey: key.current, repo, objective, budgetUsd: Number(budget),
            acceptanceCriteria: criteria.split('\n').map(line => line.trim()).filter(Boolean), scope: scope.split(/[\s,]+/).filter(Boolean), ...(accTests.trim() ? { acceptanceTests: { [accName.trim()]: accTests } } : {}), confirm: true,
        }), 'Mission transmise au CTO IA.');
        setBusy(false);
        if (created) { setSelected(created.link.id); setObjective(''); setCriteria(''); setAccTests(''); key.current = crypto.randomUUID(); }
        missions.refresh();
    };

    return <div className="page-scroll management-page"><SectionHeading index="13" title="Équipe IA" detail="Le CTO IA reçoit vos missions, les confie à ses spécialistes, exécute les tests et la revue, puis vous présente les résultats et vous demande vos validations." action={<button className="secondary" onClick={() => { team.refresh(); missions.refresh(); }}><RefreshCw size={14}/>Actualiser</button>}/>
    <ErrorBox error={team.error} retry={team.refresh}/>{team.loading && !team.data && <Loading/>}
    {team.data && <section className="form-panel team-supervisor"><div className="panel-title"><Users size={16}/><h3>CTO IA · agent superviseur</h3><span className={`badge ${connected ? 'positive' : ''}`}>{connectionLabel[sup!.connection]}</span>{sup!.registered && <span className="badge positive">ENREGISTRÉ</span>}</div>
      <p className="small">{sup!.endpoint ? `Point d’accès : ${sup!.endpoint}` : 'Aucun point d’accès configuré : définir CORTEX_CTO_URL et CORTEX_CTO_TOKEN dans l’environnement du connecteur (jamais dans le navigateur).'}{sup!.lastSeenAt ? ` · vu ${dateLabel(sup!.lastSeenAt)}` : ''}{sup!.accessRole ? ` · accès ${sup!.accessRole === 'owner' ? 'propriétaire' : 'lecture seule'}` : ''}</p>
      {sup!.error && <ErrorBox error={`${sup!.error.code} : ${sup!.error.message}`}/>}
      <div className={`team-runtime ${runtime!.status.toLowerCase()}`}><strong>Isolation d’exécution : {runtime!.status}</strong> <span className="small">{runtime!.status === 'READY' ? `${runtime!.isolation} (namespaces bubblewrap — ce n’est pas un conteneur Docker certifié)` : runtime!.blockers.join(' · ')}</span>
        {runtime!.checks.length > 0 && <small className="team-checks">{runtime!.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}`).join('  ')}</small>}</div>
      <div className="button-row"><button className="secondary" disabled={!connected || readOnly} onClick={() => void register()}><Link2 size={14}/>{sup!.registered ? 'Revérifier l’enregistrement' : 'Enregistrer le CTO IA'}</button></div></section>}

    <h4>Spécialistes</h4>
    <div className="team-agents">{team.data?.agents.map(agent => <AgentCard key={agent.role} agent={agent} missions={list}/>)}</div>

    {!projectId || !project ? <Empty title="Choisissez un projet" detail="Les missions de l’Équipe IA sont rattachées à un projet approuvé. Le CTO IA doit travailler sur le même dépôt."/> : <div className="split-management">
      <section><h3>Missions</h3><ErrorBox error={missions.error} retry={missions.refresh}/>{missions.loading && !missions.data && <Loading/>}
        {list.length === 0 && !missions.loading && <Empty title="Aucune mission" detail="Créez une mission : le CTO IA la planifie, la délègue et vous demande vos validations."/>}
        <div className="item-list">{list.map(m => <button key={m.id} className={`memory-item ${selected === m.id ? 'selected' : ''}`} onClick={() => setSelected(m.id)}><strong>{m.objective.slice(0, 80)}</strong><span className="badge">{m.localState === 'submitting' ? 'EN ATTENTE DE TRANSMISSION' : m.status.toUpperCase()}</span><small>{money(m.spentUsd)} / {money(m.budgetUsd)} · {m.pendingApprovals.length ? `approbation : ${m.pendingApprovals.join(', ')}` : dateLabel(m.updatedAt)}{m.stale ? ' · périmé' : ''}</small></button>)}</div>
        {selected && list.some(m => m.id === selected) && <MissionDetail key={selected} projectId={projectId} missionId={selected} onChanged={missions.refresh}/>}</section>
      <section className="form-panel"><h3>Nouvelle mission</h3>
        {(!connected || blocked) && <div className="error-box" role="alert"><ShieldAlert size={16}/><span>{!connected ? 'CTO IA non connecté : création impossible.' : `BLOCKED : ${runtime!.blockers.join(' · ') || 'isolation non vérifiée'}. Aucune exécution ne sera simulée.`}</span></div>}
        <form onSubmit={e => { e.preventDefault(); void create(); }}>
          <Field label="Dépôt (propriétaire/nom)" hint="Libellé GitHub de la PR préparée. Le CTO travaille sur le dépôt local de ce projet."><input required value={repo} pattern="[A-Za-z0-9][A-Za-z0-9\-]*/[A-Za-z0-9_.\-]+" onChange={e => setRepo(e.target.value)} placeholder="AiWorkPay-SASU/mon-depot"/></Field>
          <Field label="Objectif"><textarea required maxLength={1500} value={objective} onChange={e => setObjective(e.target.value)}/></Field>
          <Field label="Critères d’acceptation (un par ligne)"><textarea value={criteria} onChange={e => setCriteria(e.target.value)}/></Field>
          <Field label="Tests d'acceptation du propriétaire (facultatif)" hint="Fichier node:test que le CTO exécute lui-même ; les agents ne le voient jamais. Nom : *.test.js"><input value={accName} pattern="[A-Za-z0-9_.\-]+\.test\.(c|m)?js" onChange={e => setAccName(e.target.value)} aria-label="Nom du fichier de tests d'acceptation"/><textarea className="text-editor team-acc" value={accTests} onChange={e => setAccTests(e.target.value)} aria-label="Contenu des tests d'acceptation"/></Field>
          <Field label="Périmètre autorisé en écriture" hint="Dossiers/fichiers séparés par des espaces. Vide = non restreint. Tout changement hors périmètre est rejeté par le CTO."><input value={scope} onChange={e => setScope(e.target.value)} placeholder="src test"/></Field>
          <Field label="Budget plafond (USD)"><input required type="number" min="0.1" max="50" step="0.1" value={budget} onChange={e => setBudget(e.target.value)}/></Field>
          <button className="primary" disabled={busy || !connected || blocked || readOnly || !project.trusted}><Play size={14}/>Transmettre au CTO IA</button>
          {!project.trusted && <p className="small">Le projet doit être explicitement approuvé.</p>}
        </form></section></div>}
    <HumanDelegations/>
  </div>;
}
