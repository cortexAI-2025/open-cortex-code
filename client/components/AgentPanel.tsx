import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square, Sparkles, ShieldAlert, Plus, ChevronDown } from 'lucide-react';
import type { AgentMode, ChatMessage, CortexSession, PermissionRequest } from '../../shared/contracts';
import { dateLabel, projectRoute, useResource } from '../api';
import { useApp } from '../state';
import { Empty, ErrorBox, Loading } from './ui';
const modeDescriptions: Record<AgentMode, string> = { ask: 'Lire & comprendre. Aucun fichier modifié, aucune commande.', plan: 'Préparer une approche. Lecture seule, sans exécution.', agent: 'Construire avec permissions. Chaque action sensible reste à autoriser.' };
export function AgentPanel({ expanded = false }: {
    expanded?: boolean;
}) {
    const { api, connected, projectId, bootstrap, profileId, setProfileId, mode, setMode, session, setSession, act, confirm, setView } = useApp();
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const list = useResource<CortexSession[]>(api, projectId ? projectRoute(projectId, 'sessions') : null, 7000);
    const sessionPath = session ? `/sessions/${encodeURIComponent(session.id)}` : null;
    const messages = useResource<ChatMessage[]>(api, sessionPath ? `${sessionPath}/messages` : null, 1800);
    const permissions = useResource<PermissionRequest[]>(api, sessionPath ? `${sessionPath}/permissions` : null, 1800);
    const status = useResource<CortexSession>(api, sessionPath, 1800);
    const bottom = useRef<HTMLDivElement>(null);
    const actualSession = status.data || session;
    useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }); }, [messages.data?.length]);
    const selectSession = (item: CortexSession | null) => { setSession(item); if (item) {
        setProfileId(item.profileId);
        setMode(item.mode);
    } };
    const send = async () => {
        if (!api || !projectId || !profileId || !text.trim())
            return;
        const currentProfile = bootstrap?.profiles.find(p => p.id === actualSession?.profileId);
        const nextProfile = bootstrap?.profiles.find(p => p.id === profileId);
        const changedProvider = Boolean(currentProfile && nextProfile && (currentProfile.providerId !== nextProfile.providerId || currentProfile.baseUrl !== nextProfile.baseUrl));
        if (changedProvider && !await confirm('Envoyer le contexte à un autre fournisseur ou endpoint ?', `La session existante est conservée, mais son contexte utile sera transmis de ${currentProfile?.providerId} (${currentProfile?.baseUrl || 'endpoint natif'}) à ${nextProfile?.providerId} (${nextProfile?.baseUrl || 'endpoint natif'}). Aucun changement silencieux. Le moteur prépare le transfert de contexte.`))
            return;
        if (mode === 'agent' && !await confirm('Lancer une tâche en mode Agent ?', 'Le modèle pourra demander des modifications, commandes ou outils. Les permissions sensibles seront présentées séparément. Ask et Plan restent en lecture seule.'))
            return;
        setBusy(true);
        const result = await act(async () => {
            let target = session;
            if (!target) {
                target = await api.request<CortexSession>(projectRoute(projectId, 'sessions'), 'POST', { title: text.trim().slice(0, 70), profileId, mode });
                setSession(target);
                list.refresh();
            }
            await api.request(`/sessions/${encodeURIComponent(target.id)}/prompt`, 'POST', { text, profileId, mode, ...(changedProvider ? { confirmProviderChange: true } : {}) });
            setText('');
            messages.refresh();
            status.refresh();
            return true;
        });
        if (!result)
            status.refresh();
        setBusy(false);
    };
    return <aside className={`agent-panel ${expanded ? 'expanded' : ''}`} aria-label="Agent OpenCode"><div className="agent-heading"><div><Sparkles size={17}/><strong>Agent Cortex</strong></div><span className="badge">OPENCODE</span></div>
    <div className="session-picker"><select aria-label="Reprendre une session" disabled={!projectId} value={session?.id || ''} onChange={e => selectSession(list.data?.find(s => s.id === e.target.value) || null)}><option value="">Nouvelle session</option>{list.data?.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select><button className="icon-button" title="Nouvelle session" aria-label="Nouvelle session" onClick={() => selectSession(null)}><Plus size={15}/></button></div>
    <ErrorBox error={list.error}/>
    <div className="messages"><ErrorBox error={messages.error} retry={messages.refresh}/><ErrorBox error={status.error}/><ErrorBox error={permissions.error}/>{messages.loading && <Loading />}
      {!session && <Empty title={connected ? 'Une intention. Une session.' : 'Votre moteur attend votre choix.'} detail={connected ? 'Choisissez un projet et un profil, puis posez une question. Votre conversation sera conservée localement.' : 'Pas de conversation simulée. Associez votre connecteur pour travailler sur votre propre code.'}><button className="secondary" onClick={() => setView(!connected ? 'settings' : !projectId ? 'projects' : 'models')}>{!connected ? 'Associer le moteur' : !projectId ? 'Choisir un projet' : 'Configurer un modèle'}</button></Empty>}
      {session && messages.data?.length === 0 && <p className="small">La session est ouverte. Aucun message retourné pour le moment.</p>}
      {messages.data?.map(message => <article key={message.id} className={`message ${message.role}`}><header><span>{message.role === 'assistant' ? 'OPENCODE' : message.role === 'user' ? 'VOUS' : 'SYSTÈME'}</span><time>{dateLabel(message.createdAt)}</time></header><div className="message-text">{message.text}</div>{message.error && <ErrorBox error={message.error}/>}{message.tools?.map(tool => <details className="tool-action" key={tool.id}><summary><ChevronDown size={13}/>{tool.name}<span>{tool.status}</span></summary>{tool.input !== undefined && <pre>{JSON.stringify(tool.input, null, 2)}</pre>}{tool.output && <pre>{tool.output}</pre>}</details>)}{message.tokens && <small className="message-metrics">{message.tokens.input.toLocaleString('fr-FR')} tokens entrée · {message.tokens.output.toLocaleString('fr-FR')} sortie{message.cost !== undefined ? ` · coût moteur ${message.cost}` : ''}</small>}</article>)}
      {permissions.data?.map(permission => <div className="permission-card" key={permission.id}><div><ShieldAlert size={18}/><strong>Permission requise</strong></div><p>{permission.description || permission.action}</p><pre>{permission.resources.join('\n')}</pre><div className="button-row"><button className="secondary" disabled={busy} onClick={async () => { if (!api || !sessionPath)
        return; setBusy(true); await act(() => api.request(`${sessionPath}/permissions/${encodeURIComponent(permission.id)}`, 'POST', { decision: 'reject' })); permissions.refresh(); setBusy(false); }}>Refuser</button><button className="primary" disabled={busy} onClick={async () => { if (!api || !sessionPath || !await confirm('Autoriser cette action une seule fois ?', `${permission.action}\n${permission.resources.join('\n')}\nLes permissions ne sont pas un sandbox OS.`))
        return; setBusy(true); await act(() => api.request(`${sessionPath}/permissions/${encodeURIComponent(permission.id)}`, 'POST', { decision: 'once' })); permissions.refresh(); setBusy(false); }}>Autoriser une fois</button></div></div>)}<div ref={bottom}/>
    </div>
    <div className="composer"><div className="mode-tabs" role="group" aria-label="Mode agent">{(['ask', 'plan', 'agent'] as AgentMode[]).map(item => <button className={mode === item ? 'active' : ''} key={item} onClick={() => setMode(item)}>{item === 'ask' ? 'Ask' : item === 'plan' ? 'Plan' : 'Agent'}</button>)}</div><p className="mode-help">{modeDescriptions[mode]}</p><select aria-label="Profil fournisseur pour la prochaine requête" value={profileId} disabled={!connected} onChange={e => setProfileId(e.target.value)}><option value="">Choisir un profil BYOK</option>{bootstrap?.profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {p.modelId}</option>)}</select>
      <form onSubmit={e => { e.preventDefault(); void send(); }}><textarea value={text} onChange={e => setText(e.target.value)} placeholder={connected ? 'Décrivez votre prochaine tâche…' : 'Connectez votre moteur pour commencer…'} disabled={!connected || !projectId} aria-label="Message de la session" onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void send();
    } }}/><div className="composer-bottom"><small>{actualSession ? actualSession.status : 'Aucune session active'}</small>{actualSession?.status === 'running' && <button type="button" className="icon-button" title="Interrompre la session" aria-label="Interrompre la session" onClick={() => { if (api && sessionPath)
        void act(() => api.request(`${sessionPath}/interrupt`, 'POST'), 'Interruption demandée au moteur.'); }}><Square size={14}/></button>}<button className="send-button" type="submit" title="Envoyer (Ctrl+Entrée)" aria-label="Envoyer la demande" disabled={!connected || !projectId || !profileId || !text.trim() || busy || actualSession?.status === 'running'}><ArrowUp size={19}/></button></div></form>
      <div className="agent-footnote">Vos clés. Votre appareil. Aucune autorisation permanente.</div>
    </div></aside>;
}
