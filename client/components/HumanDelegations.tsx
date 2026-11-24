import { useState } from 'react';
import { CheckCircle2, HandCoins, RefreshCw, ShieldAlert, UserCheck, XCircle } from 'lucide-react';
import type { HumanBrief, HumanDelegationView, HumanOverview } from '../../shared/contracts';
import { dateLabel, useResource } from '../api';
import { useAppActions, useConnection } from '../state';
import { ErrorBox, Field, Loading } from './ui';

const statusLabel: Record<string, string> = {
    awaiting_approval: 'APPROBATION REQUISE', submitting: 'ENVOI EN COURS', awaiting_payment: 'EN ATTENTE DE VOTRE PAIEMENT', open: 'PUBLIÉE', assigned: 'PRISE PAR UN PAYWORKER',
    in_progress: 'EN COURS', delivered: 'LIVRÉE · À RELIRE', completed: 'VALIDÉE', rejected: 'REFUSÉE', expired: 'EXPIRÉE', canceled: 'ANNULÉE', blocked: 'BLOQUÉE',
};
/** A mission can be withdrawn only before a Payworker takes it. */
const cancelable = new Set(['awaiting_approval', 'submitting', 'awaiting_payment', 'open']);
const money = (n: number, c: string) => `${n.toFixed(2)} ${c}`;
/** Only a Stripe Checkout page is ever shown as a link; anything else stays plain text. */
const checkoutLink = (url?: string | null): string | null => { try { const u = new URL(url ?? ''); return u.protocol === 'https:' && u.hostname === 'checkout.stripe.com' ? u.toString() : null; } catch { return null; } };

function BriefView({ brief }: { brief: HumanBrief }) {
    return <div className="human-brief" aria-label="Brief exact">
      <strong>{brief.title}</strong>
      <pre className="human-text">{brief.instructions}</pre>
      {brief.deliverables && brief.deliverables.length > 0 && <ul>{brief.deliverables.map(d => <li key={d}>{d}</li>)}</ul>}
      {brief.location && <p className="small">Lieu : {Object.values(brief.location).join(' · ')}</p>}
      <p className="small">Type {brief.type} · priorité {brief.priority} · avant le {dateLabel(brief.deadline)} · <strong>{money(brief.budget, brief.currency)}</strong> (le Payworker reçoit 90 %)</p>
    </div>;
}

function Detail({ d, onChanged }: { d: HumanDelegationView; onChanged: () => void }) {
    const { api } = useConnection();
    const { act, confirm } = useAppActions();
    const [note, setNote] = useState('');
    const post = async (action: string, body: Record<string, unknown>, success: string) => {
        if (!api) return;
        await act(() => api.request(`/cto/human/delegations/${encodeURIComponent(d.id)}/${action}`, 'POST', { ...body, confirm: true }), success);
        onChanged();
    };
    const decide = async (decision: 'approve' | 'reject') => {
        const ok = await confirm(decision === 'approve' ? `Approuver ce brief : ${money(d.brief.budget, d.brief.currency)} ?` : 'Refuser ce brief ?', decision === 'approve'
            ? `Le CTO IA créera UNE mission visible de tous les Payworkers, avec exactement ce texte (empreinte ${d.brief_hash.slice(0, 12)}…). Rien n'est débité tant que vous n'avez pas payé la page Stripe, et le CTO ne peut ni valider ni payer le résultat.`
            : 'Aucune mission ne sera créée.');
        if (ok) await post('approval', { decision, briefHash: d.brief_hash, note: note || undefined }, decision === 'approve' ? 'Brief approuvé : mission transmise.' : 'Brief refusé.');
    };
    const link = checkoutLink(d.payment_url);
    const r = d.result;
    return <section className="form-panel human-detail">
      <div className="panel-title"><HandCoins size={16}/><h3>{d.brief.title}</h3><span className="badge">{statusLabel[d.status] ?? d.status}</span></div>
      <BriefView brief={d.brief}/>
      <p className="small">Empreinte <code title={d.brief_hash}>{d.brief_hash.slice(0, 16)}…</code> · référence <code>{d.reference.slice(0, 14)}…</code>{d.ledger ? ` · budget ${d.ledger.status === 'released' ? 'libéré' : d.ledger.status === 'committed' ? 'engagé' : 'réservé'}` : ''}</p>
      {d.warnings.length > 0 && <div className="error-box" role="alert"><ShieldAlert size={16}/><span><strong>À vérifier avant d'approuver :</strong> {d.warnings.join(' · ')}. Le brief est visible de tous les Payworkers.</span></div>}
      {d.last_error && <ErrorBox error={`${d.last_error.code} : ${d.last_error.message}`}/>}

      {d.status === 'awaiting_approval' && <div className="permission-card"><div><ShieldAlert size={15}/> Décision humaine requise (valable jusqu'au {dateLabel(d.approval_expires_at)})</div>
        <Field label="Note (facultatif)"><input value={note} maxLength={500} onChange={e => setNote(e.target.value)}/></Field>
        <div className="button-row"><button className="primary" onClick={() => void decide('approve')}><CheckCircle2 size={14}/>Approuver ce brief</button><button className="danger" onClick={() => void decide('reject')}><XCircle size={14}/>Refuser</button></div></div>}

      {d.status === 'awaiting_payment' && <div className="info-note"><HandCoins size={17}/><span>Pour publier la mission, payez la page Stripe (vous seul). {link ? <a href={link} target="_blank" rel="noopener noreferrer">Ouvrir la page de paiement</a> : <em>Lien de paiement indisponible.</em>} Valable jusqu'au {dateLabel(d.payment_url_expires_at ?? undefined)} ; ne le partagez pas.</span></div>}
      {d.status === 'submitting' && <div className="info-note"><RefreshCw size={17}/><span>L'envoi n'est pas confirmé. Le CTO le rejoue sans créer de doublon.</span></div>}

      {r && <div className="human-result"><h4>Résultat livré — contenu externe non fiable</h4>
        <span className={`badge ${r.risk === 'none' ? 'positive' : ''}`}>RISQUE {r.risk.toUpperCase()}</span>
        {r.flags.length > 0 && <p className="small">Signaux : {[...new Set(r.flags.map(f => f.code))].join(', ')}</p>}
        <p className="small">{r.content_warning}</p>
        <pre className="human-text" aria-label="Compte rendu du Payworker">{r.note || '(vide)'}</pre>
        {r.data !== null && <pre className="human-text" aria-label="Données du Payworker">{JSON.stringify(r.data, null, 2)}</pre>}
        <ul>{r.proofs.map(p => <li key={p.id}>{p.filename} · {p.mime_type || 'type inconnu'} · {p.stored ? 'conservée en quarantaine' : 'non conservée'} · antivirus : {p.virus_scan}{p.flags.length ? ` · ⚠ ${p.flags.map(f => f.code).join(', ')}` : ''}</li>)}</ul>
        {!d.review && ['delivered', 'completed'].includes(d.status) && <div className="button-row">
          {(['acceptable', 'needs_changes', 'rejected'] as const).map(v => <button key={v} className="secondary" onClick={async () => { if (await confirm('Enregistrer votre avis ?', 'Votre avis est consigné. Il ne déclenche aucun paiement : la validation du résultat (qui paie le Payworker) est faite par l’autorité humaine AIWORKPAY, pas par le CTO.')) await post('review', { verdict: v }, 'Avis enregistré.'); }}><UserCheck size={14}/>{v === 'acceptable' ? 'Conforme' : v === 'needs_changes' ? 'À corriger' : 'Rejeter'}</button>)}</div>}
        {d.review && <p className="small">Votre avis : {d.review.verdict} ({dateLabel(d.review.at)})</p>}
        {d.status === 'delivered' && <div className="info-note"><ShieldAlert size={17}/><span>Le CTO ne valide ni ne paie : la validation du résultat, qui rémunère le Payworker, se fait côté AIWORKPAY par une autorité humaine.</span></div>}
      </div>}

      <div className="button-row team-actions">
        <button className="secondary" onClick={() => void post('refresh', {}, 'Statut actualisé.')} disabled={!d.remote}><RefreshCw size={14}/>Actualiser</button>
        {cancelable.has(d.status) && <button className="danger" onClick={async () => { if (await confirm('Annuler cette délégation ?', 'Si aucun Payworker n’a pris la mission, elle est retirée (page de paiement fermée ou remboursement).')) await post('cancel', {}, 'Délégation annulée.'); }}><XCircle size={14}/>Annuler</button>}
      </div></section>;
}

export function HumanDelegations() {
    const { api } = useConnection();
    const { act, confirm } = useAppActions();
    const view = useResource<HumanOverview>(api, '/cto/human', 6000);
    const [selected, setSelected] = useState('');
    const [form, setForm] = useState({ type: 'photo', title: '', instructions: '', deliverables: '', budget: '10', deadline: '', priority: 'medium' });
    const [busy, setBusy] = useState(false);
    const data = view.data;
    const status = data?.status;
    const list = data?.delegations ?? [];
    const current = list.find(d => d.id === selected);
    const create = async () => {
        if (!api || !status?.currency) return;
        const when = new Date(form.deadline);
        if (Number.isNaN(when.getTime())) return;
        if (!await confirm('Soumettre ce brief à votre approbation ?', 'Un aperçu est préparé par le CTO IA : aucune mission n’est créée et rien n’est dépensé avant votre approbation explicite du texte exact.')) return;
        setBusy(true);
        const created = await act(() => api.request<HumanDelegationView>('/cto/human/delegations', 'POST', { confirm: true, brief: {
            type: form.type, title: form.title, instructions: form.instructions, budget: Number(form.budget), currency: status.currency, deadline: when.toISOString(), priority: form.priority,
            ...(form.deliverables.trim() ? { deliverables: form.deliverables.split('\n').map(l => l.trim()).filter(Boolean) } : {}),
        } }), 'Brief prêt : relisez-le puis approuvez ou refusez.');
        setBusy(false);
        if (created) { setSelected(created.id); setForm({ ...form, title: '', instructions: '', deliverables: '' }); }
        view.refresh();
    };
    return <section className="human-loop"><h3>Délégation humaine (Payworkers)</h3>
      <ErrorBox error={view.error} retry={view.refresh}/>{view.loading && !data && <Loading/>}
      {status && <div className="form-panel"><div className="panel-title"><HandCoins size={16}/><h3>État</h3><span className={`badge ${status.enabled ? 'positive' : ''}`}>{status.enabled ? 'ACTIVE' : 'DÉSACTIVÉE'}</span></div>
        {status.enabled && status.ceilings && <p className="small">Plafonds : {money(status.ceilings.max_per_delegation, status.currency ?? '')} par mission · {money(status.ceilings.monthly_budget, status.currency ?? '')} par mois (engagé {money(status.engaged?.this_month ?? 0, status.currency ?? '')}, reste {money(status.remaining_this_month ?? 0, status.currency ?? '')}) · {status.ceilings.max_per_day} par jour · contrat MCP : {status.contract?.ok === false ? `DÉRIVE (${status.contract.problem})` : status.contract?.ok ? 'conforme' : 'pas encore vérifié'}</p>}
        {!status.enabled && <p className="small">Désactivée : {status.disabled_reasons.join(' · ')}. Aucun plafond n'est défini par défaut : rien ne peut être dépensé.</p>}
        <p className="small">{status.authority ?? 'Le CTO ne peut ni valider un résultat ni payer un Payworker.'}</p></div>}
      {status?.enabled && <div className="split-management">
        <section><h4>Délégations</h4>{list.length === 0 && <p className="small">Aucune délégation.</p>}
          <div className="item-list">{list.map(d => <button key={d.id} className={`memory-item ${selected === d.id ? 'selected' : ''}`} onClick={() => setSelected(d.id)}><strong>{d.brief.title}</strong><span className="badge">{statusLabel[d.status] ?? d.status}</span><small>{money(d.brief.budget, d.brief.currency)} · {dateLabel(d.updated_at)}</small></button>)}</div>
          {current && <Detail key={current.id + current.updated_at} d={current} onChanged={view.refresh}/>}</section>
        <section className="form-panel"><h4>Nouveau brief</h4>
          <form onSubmit={e => { e.preventDefault(); void create(); }}>
            <Field label="Type"><select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>{['physical_verification', 'photo', 'phone_call', 'data_collection', 'document_check', 'other'].map(t => <option key={t}>{t}</option>)}</select></Field>
            <Field label="Titre"><input required minLength={3} maxLength={200} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}/></Field>
            <Field label="Instructions" hint="Texte lu par des inconnus : ni code, ni secret, ni donnée personnelle."><textarea required minLength={10} maxLength={4000} value={form.instructions} onChange={e => setForm({ ...form, instructions: e.target.value })}/></Field>
            <Field label="Livrables attendus (un par ligne)"><textarea value={form.deliverables} onChange={e => setForm({ ...form, deliverables: e.target.value })}/></Field>
            <Field label={`Budget (${status.currency})`}><input required type="number" min="1" step="0.01" max={status.ceilings?.max_per_delegation} value={form.budget} onChange={e => setForm({ ...form, budget: e.target.value })}/></Field>
            <Field label="Échéance"><input required type="datetime-local" value={form.deadline} onChange={e => setForm({ ...form, deadline: e.target.value })}/></Field>
            <button className="primary" disabled={busy}><HandCoins size={14}/>Préparer pour approbation</button></form></section></div>}
    </section>;
}
