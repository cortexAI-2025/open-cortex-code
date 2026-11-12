import type { CortexSession } from '../../shared/contracts';
import { dateLabel, projectRoute, useResource } from '../api';
import { useApp } from '../state';
import { Empty, ErrorBox, Loading, SectionHeading } from '../components/ui';
export function Sessions() {
    const { api, projectId, setSession, setProfileId, setMode, setView } = useApp();
    const sessions = useResource<CortexSession[]>(api, projectId ? projectRoute(projectId, 'sessions') : null, 5000);
    return <div className="page-scroll management-page"><SectionHeading index="04" title="Sessions" detail="Reprenez une conversation existante sans recréer son contexte moteur." action={<button className="primary" onClick={() => { setSession(null); setView('editor'); }}>Nouvelle session</button>}/><ErrorBox error={sessions.error} retry={sessions.refresh}/>{sessions.loading && <Loading />}
    {!sessions.data?.length && !sessions.loading && !sessions.error && <Empty title="Aucune session enregistrée" detail="La première question dans le panneau agent créera une session locale réelle."/>}
    <div className="item-list">{sessions.data?.map(item => <button className="session-item" key={item.id} onClick={() => { setSession(item); setProfileId(item.profileId); setMode(item.mode); setView('editor'); }}><div><strong>{item.title}</strong><small>{dateLabel(item.updatedAt)} · {item.mode.toUpperCase()}</small></div><span className="badge">{item.status}</span></button>)}</div>
  </div>;
}
