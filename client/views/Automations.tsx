import { useState } from 'react';
import { CalendarClock, Play, Plus, Trash2 } from 'lucide-react';
import type { AgentMode, Automation, CortexSession } from '../../shared/contracts';
import { dateLabel, projectRoute, useResource } from '../api';
import { useApp } from '../state';
import { Empty, ErrorBox, Field, Loading, SectionHeading } from '../components/ui';
interface LocalAutomation extends Automation {
    dayOfWeek?: number;
    lastRun?: string;
    lastError?: string;
    lastSessionId?: string;
}
export function Automations() {
    const { api, projectId, bootstrap, profileId, act, confirm, setSession, setView } = useApp();
    const records = useResource<LocalAutomation[]>(api, projectId ? projectRoute(projectId, 'automations') : null, 10000);
    const [editing, setEditing] = useState<LocalAutomation | null>(null);
    const [name, setName] = useState('');
    const [prompt, setPrompt] = useState('');
    const [profile, setProfile] = useState(profileId);
    const [mode, setMode] = useState<AgentMode>('ask');
    const [schedule, setSchedule] = useState<Automation['schedule']>('manual');
    const [time, setTime] = useState('');
    const [day, setDay] = useState(1);
    const [enabled, setEnabled] = useState(false);
    const [consent, setConsent] = useState(false);
    const [busy, setBusy] = useState(false);
    const reset = () => { setEditing(null); setName(''); setPrompt(''); setProfile(profileId); setMode('ask'); setSchedule('manual'); setTime(''); setEnabled(false); setConsent(false); };
    return <div className="page-scroll management-page"><SectionHeading index="09" title="Automatisations" detail="Planification appartenant au connecteur local. Rien ne tourne dans le cloud en votre absence." action={<button className="secondary" onClick={reset}><Plus size={14}/>Nouvelle tâche</button>}/>
    <div className="info-note"><CalendarClock size={17}/><span>Les tâches planifiées fonctionnent uniquement pendant la disponibilité du connecteur et des secrets locaux. Non surveillées : Ask uniquement, sans shell, mutation, MCP ni sous-agent. Événements GitHub/CI non configurés ici.</span></div>
    <div className="split-management"><section><ErrorBox error={records.error} retry={records.refresh}/>{records.loading && <Loading />}<div className="item-list">{records.data?.map(item => <div className="automation-item" key={item.id}><header><strong>{item.name}</strong><span className="badge">{item.enabled ? 'Configuration activée' : 'Désactivée'}</span></header><p>{item.prompt}</p><div className="automation-facts"><span>{item.schedule} · {item.mode.toUpperCase()}</span><small>Prochaine échéance : {dateLabel(item.nextRun)}</small><small>Dernier lancement : {dateLabel(item.lastRun)}</small></div>{item.lastError && <ErrorBox error={item.lastError}/>}<div className="button-row"><button className="secondary" disabled={busy} onClick={() => { setEditing(item); setName(item.name); setPrompt(item.prompt); setProfile(item.profileId); setMode(item.mode); setSchedule(item.schedule); setTime(item.schedule === 'once' && item.time ? new Date(new Date(item.time).getTime() - new Date(item.time).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : item.time || ''); setDay(item.dayOfWeek ?? 1); setEnabled(item.enabled); setConsent(false); }}>Modifier</button><button className="primary" disabled={busy} onClick={async () => { if (!api || !await confirm('Lancer cette tâche maintenant ?', `Une session ${item.mode.toUpperCase()} sera créée avec son fournisseur configuré. Le lancement n’est pas une confirmation de résultat ; les permissions du moteur restent explicites.`))
        return; setBusy(true); const session = await act(() => api.request<CortexSession>(projectRoute(projectId, `automations/${item.id}/run`), 'POST', { confirm: true })); if (session) {
        setSession(session);
        setView('editor');
    } records.refresh(); setBusy(false); }}><Play size={13}/>Exécuter</button><button className="icon-button" disabled={busy} title="Supprimer l’automatisation" aria-label={`Supprimer ${item.name}`} onClick={async () => { if (!api || !await confirm('Supprimer l’automatisation ?', 'Sa configuration locale sera supprimée. Les sessions déjà lancées ne seront pas interrompues.'))
        return; await act(() => api.request(projectRoute(projectId, `automations/${item.id}`), 'DELETE', { confirm: true })); records.refresh(); }}><Trash2 size={14}/></button></div></div>)}</div>{records.data?.length === 0 && <Empty title="Aucune tâche programmée" detail="Créez une configuration manuelle ou une échéance locale consentie. Aucun job caché."/>}</section>
    <section className="form-panel"><h3>{editing ? 'Modifier la configuration' : 'Configurer une tâche locale'}</h3><form onSubmit={async (e) => {
            e.preventDefault();
            if (!api || !await confirm(enabled ? 'Activer cette automatisation locale ?' : 'Enregistrer cette configuration ?', enabled ? 'Cette configuration autorise des appels fournisseur aux échéances définies tant que le connecteur et ses secrets sont disponibles. Du quota peut être consommé. Les modes mutateurs ne sont permis qu’en lancement manuel confirmé.' : 'La configuration reste désactivée et ne provoque aucun appel modèle.'))
                return;
            setBusy(true);
            const value = await act(() => api.request(projectRoute(projectId, editing ? `automations/${editing.id}` : 'automations'), editing ? 'PUT' : 'POST', { name, prompt, profileId: profile, mode: schedule !== 'manual' ? 'ask' : mode, schedule, enabled, confirm: true, consent, ...(schedule === 'manual' ? {} : { time: schedule === 'once' ? new Date(time).toISOString() : time }), ...(schedule === 'weekly' ? { dayOfWeek: day } : {}) }), 'Configuration enregistrée par le planificateur local.');
            if (value) {
                reset();
                records.refresh();
            }
            setBusy(false);
        }}><Field label="Nom"><input required value={name} onChange={e => setName(e.target.value)}/></Field><Field label="Instruction"><textarea required className="text-editor" value={prompt} onChange={e => setPrompt(e.target.value)}/></Field><Field label="Profil fournisseur"><select required value={profile} onChange={e => setProfile(e.target.value)}><option value="">Choisir un profil</option>{bootstrap?.profiles.map(p => <option value={p.id} key={p.id}>{p.name} · {p.modelId}</option>)}</select></Field>
      <div className="two-fields"><Field label="Déclenchement"><select value={schedule} onChange={e => { setSchedule(e.target.value as Automation['schedule']); setTime(''); if (e.target.value !== 'manual')
        setMode('ask'); }}><option value="manual">Manuel</option><option value="once">Une fois</option><option value="daily">Quotidien</option><option value="weekly">Hebdomadaire</option></select></Field><Field label="Mode"><select value={mode} onChange={e => setMode(e.target.value as AgentMode)} disabled={schedule !== 'manual'}><option value="ask">Ask · lecture seule</option><option value="plan">Plan · manuel</option><option value="agent">Agent · manuel</option></select></Field></div>
      {schedule !== 'manual' && <Field label={schedule === 'once' ? 'Date / heure sur cet appareil' : 'Heure locale du connecteur (HH:mm)'}><input required type={schedule === 'once' ? 'datetime-local' : 'time'} value={time} onChange={e => setTime(e.target.value)}/></Field>}{schedule === 'weekly' && <Field label="Jour"><select value={day} onChange={e => setDay(Number(e.target.value))}>{['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'].map((label, i) => <option value={i} key={label}>{label}</option>)}</select></Field>}
      <label className="check-field"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}/>Activer la configuration.</label>{enabled && <label className="check-field"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/>J’autorise ces appels locaux et leur consommation de quota éventuelle.</label>}<button className="primary" disabled={busy || enabled && !consent}>Enregistrer la tâche</button>
    </form></section></div>
  </div>;
}
