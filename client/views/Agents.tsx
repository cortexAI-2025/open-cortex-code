import { useState } from 'react';
import { GitFork, Play } from 'lucide-react';
import type { AgentMode, CortexSession } from '../../shared/contracts';
import { dateLabel, projectRoute, useResource } from '../api';
import { useApp } from '../state';
import { Empty, ErrorBox, Field, Loading, SectionHeading } from '../components/ui';
interface ParallelAgent {
    id: string;
    isolatedProjectId: string;
    name: string;
    task: string;
    profileId: string;
    mode: AgentMode;
    branch: string;
    worktreePath: string;
    sessionId?: string;
    state: string;
    sessionStatus: string | null;
    error?: string;
    createdAt: string;
    warning: string;
}
export function Agents() {
    const { api, projectId, project, profileId, bootstrap, act, confirm, refresh, setProjectId, setSession, setProfileId, setMode, setView } = useApp();
    const agents = useResource<ParallelAgent[]>(api, projectId ? projectRoute(projectId, 'agents') : null, 6000);
    const [name, setName] = useState('');
    const [task, setTask] = useState('');
    const [profile, setProfile] = useState(profileId);
    const [mode, setTaskMode] = useState<AgentMode>('ask');
    const [busy, setBusy] = useState(false);
    const resume = async (agent: ParallelAgent) => {
        if (!api || !agent.sessionId)
            return;
        await act(async () => {
            const session = await api.request<CortexSession>(`/sessions/${encodeURIComponent(agent.sessionId!)}`);
            await refresh();
            if (!await setProjectId(agent.isolatedProjectId))
                return;
            setSession(session);
            setProfileId(session.profileId);
            setMode(session.mode);
            setView('editor');
        });
    };
    return <div className="page-scroll management-page"><SectionHeading index="05" title="Agents parallèles" detail="Une tâche, un worktree Git unique et une session propre. Pas de fusion automatique."/>
    <div className="info-note"><GitFork size={17}/><span>Un worktree isole les fichiers et la branche Git, pas les processus, le réseau ou les secrets. Code non fiable : environnement externe isolé requis. Intégration des changements à examiner manuellement.</span></div>
    <div className="split-management"><section><ErrorBox error={agents.error} retry={agents.refresh}/>{agents.loading && <Loading />}{agents.data?.length === 0 && <Empty title="Aucun agent worktree" detail="Créez une tâche réellement indépendante dans un projet Git approuvé."/>}{agents.data?.map(agent => <article className="form-panel agent-record" key={agent.id}><div className="panel-title"><GitFork size={16}/><h3>{agent.name}</h3><span className="badge">{agent.sessionStatus || agent.state}</span></div><p>{agent.task}</p><div className="agent-worktree"><code>{agent.branch}</code><code>{agent.worktreePath}</code><small>{dateLabel(agent.createdAt)} · {agent.mode.toUpperCase()}</small></div>{agent.error && <ErrorBox error={agent.error}/>}<p className="small">{agent.warning}</p><button className="secondary" disabled={!agent.sessionId || busy} onClick={() => void resume(agent)}>Examiner le projet & sa session</button></article>)}</section>
    <section className="form-panel"><h3>Créer un agent worktree</h3><form onSubmit={async (e) => { e.preventDefault(); if (!api || !await confirm('Créer une tâche parallèle ?', `Un worktree et une session ${mode.toUpperCase()} seront créés sur votre appareil. Le profil ${profile} sera utilisé. Aucun merge, push ni environnement OS isolé n’est promis.`))
        return; setBusy(true); await act(async () => { const value = await api.request(projectRoute(projectId, 'agents'), 'POST', { name, task, profileId: profile, mode, confirm: true }); await refresh(); return value; }, 'Tâche worktree créée. Les résultats sont à examiner, pas présumés terminés.'); agents.refresh(); setBusy(false); }}>
      <Field label="Nom de la tâche"><input required value={name} onChange={e => setName(e.target.value)}/></Field><Field label="Mission"><textarea required className="text-editor" value={task} onChange={e => setTask(e.target.value)}/></Field><Field label="Profil BYOK"><select required value={profile} onChange={e => setProfile(e.target.value)}><option value="">Choisir un profil</option>{bootstrap?.profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {p.modelId}</option>)}</select></Field><Field label="Mode"><select value={mode} onChange={e => setTaskMode(e.target.value as AgentMode)}><option value="ask">Ask</option><option value="plan">Plan</option><option value="agent">Agent (permissions requises)</option></select></Field><button className="primary" disabled={busy || !project?.trusted || !profile}><Play size={14}/>Créer & lancer la tâche</button>{!project?.trusted && <p className="small">Le projet doit être explicitement approuvé pour cette opération Git et moteur.</p>}
    </form></section></div>
  </div>;
}
