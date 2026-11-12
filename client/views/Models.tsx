import { useEffect, useState } from 'react';
import { KeyRound, ShieldCheck, FlaskConical, Trash2 } from 'lucide-react';
import type { Profile } from '../../shared/contracts';
import { useApp } from '../state';
import { projectRoute, useResource } from '../api';
import { Empty, ErrorBox, Field, Loading, SectionHeading } from '../components/ui';
export interface CatalogModel {
    id: string;
    name: string;
    context?: number;
    tools?: boolean;
    reasoning?: boolean;
    cost?: unknown;
}
export interface Catalog {
    providers: {
        id: string;
        name: string;
        models: CatalogModel[];
    }[];
}
export function Models() {
    const { api, connected, remote, projectId, bootstrap, profileId, setProfileId, act, refresh, confirm, setView, notify } = useApp();
    const catalog = useResource<Catalog>(api, projectId ? projectRoute(projectId, 'models') : null);
    const [name, setName] = useState('');
    const [providerId, setProvider] = useState('');
    const [modelId, setModel] = useState('');
    const [baseUrl, setBaseUrl] = useState('');
    const [apiKey, setKey] = useState('');
    const [custom, setCustom] = useState(false);
    const [busy, setBusy] = useState(false);
    const [vault, setVault] = useState<{
        available: boolean;
        backend: string;
    } | null>(null);
    const [persist, setPersist] = useState(false);
    const [rotation, setRotation] = useState('');
    useEffect(() => { if (connected && window.cortexDesktop?.vaultStatus)
        void act(async () => setVault(await window.cortexDesktop!.vaultStatus!())); }, [connected]);
    useEffect(() => { if (!custom && catalog.data) {
        const preferred = catalog.data.providers.find(p => /zai|z\.ai/i.test(p.id) && p.models.some(m => /glm-4\.5-flash/i.test(m.id))) || catalog.data.providers.find(p => p.models.some(m => /glm-4\.5-flash/i.test(m.id))) || catalog.data.providers[0];
        if (preferred && !providerId) {
            setProvider(preferred.id);
            setModel(preferred.models.find(m => /glm-4\.5-flash/i.test(m.id))?.id || preferred.models[0]?.id || '');
        }
    } }, [catalog.data, custom]);
    const models = catalog.data?.providers.find(p => p.id === providerId)?.models || [];
    const metadata = models.find(m => m.id === modelId);
    const selected = bootstrap?.profiles.find(p => p.id === profileId);
    if (remote)
        return <div className="page-scroll management-page"><SectionHeading index="03" title="Modèles & clés" detail="Le client HTTPS utilise les profils locaux déjà configurés, mais ne reçoit jamais leurs secrets."/><section className="form-panel"><div className="panel-title"><ShieldCheck size={17}/><h3>Credentials réservés à l’interface locale</h3><span className="badge">LECTURE SEULE</span></div><p>La configuration ou la rotation d'une clé, la création de profil avec secret et la lecture du coffre OS sont bloquées côté connecteur pour une origine distante. Utilisez l’interface locale sur cet appareil pour gérer les credentials.</p>{!bootstrap?.profiles.length ? <Empty title="Aucun profil local" detail="Créez le premier profil depuis l’interface Web locale ou Desktop."/> : <div className="item-list">{bootstrap.profiles.map(profile => <div key={profile.id} className="profile-item"><div><strong>{profile.name}</strong><code>{profile.providerId} / {profile.modelId}</code></div><span className="badge">{profile.hasSecret ? 'Secret local configuré' : 'Sans secret'}</span></div>)}</div>}</section></div>;
    if (!connected)
        return <Empty title="Vos clés ne quittent pas la frontière locale" detail="Associez explicitement un connecteur loopback avant de configurer vos profils. Aucun champ secret n’est proposé en mode Preview déconnecté."><button className="primary" onClick={() => setView('settings')}>Associer le connecteur</button></Empty>;
    const secretAction = async (action: 'rotate' | 'delete' | 'load') => {
        if (!api || !selected)
            return;
        if (!await confirm('Modifier le secret du profil ?', `Profil ${selected.name} sur ${api.connection.url}. ${action === 'delete' ? 'Supprimer le secret mémoire et, si présent, celui du coffre OS.' : 'Transmettre la clé au connecteur explicitement associé. Aucun stockage navigateur.'}`))
            return;
        setBusy(true);
        await act(async () => {
            if (action === 'delete') {
                await api.request(`/profiles/${selected.id}/secret`, 'DELETE');
                if (vault?.available)
                    await window.cortexDesktop?.deleteSecret?.(selected.id);
            }
            else {
                const secret = action === 'load' ? await window.cortexDesktop?.loadSecret?.(selected.id) : rotation;
                if (!secret)
                    throw new Error('Aucun secret fourni ou disponible dans le coffre.');
                await api.request(`/profiles/${selected.id}/secret`, 'PUT', { apiKey: secret });
                if (persist && vault?.available && action === 'rotate')
                    await window.cortexDesktop?.saveSecret?.(selected.id, secret);
            }
            await refresh();
        }, 'État du secret mis à jour par le connecteur.');
        setRotation('');
        setBusy(false);
    };
    return <div className="page-scroll management-page"><SectionHeading index="03" title="Modèles & clés" detail="BYOK : votre fournisseur, votre modèle, votre secret. Aucun accès externe n’est supposé valide."/>
    <div className="split-management"><section className="form-panel"><div className="panel-title"><KeyRound size={17}/><h3>Configurer un profil</h3><span className="badge">MÉMOIRE LOCALE</span></div>
      {!projectId && <p className="info-note">Ouvrez un projet pour charger le catalogue réel OpenCode. Vous pouvez aussi saisir un profil personnalisé explicitement.</p>}
      <ErrorBox error={catalog.error} retry={catalog.refresh}/>{catalog.loading && <Loading />}
      <form onSubmit={async (e) => {
            e.preventDefault();
            if (!api)
                return;
            if (!await confirm('Configurer ce fournisseur ?', `Les futures requêtes de ce profil utiliseront ${providerId} / ${modelId}. Le secret sera transmis uniquement à ${api.connection.url}, puis utilisé localement pour joindre ce fournisseur. ${persist ? 'Vous avez choisi le coffre OS pour conserver la clé.' : 'Le secret reste en mémoire du connecteur.'}`))
                return;
            setBusy(true);
            const secret = apiKey;
            setKey('');
            const result = await act(async () => { const profile = await api.request<Profile>('/profiles', 'POST', { name, providerId, modelId, ...(baseUrl ? { baseUrl } : {}), ...(secret ? { apiKey: secret } : {}) }); if (persist && vault?.available && secret)
                await window.cortexDesktop?.saveSecret?.(profile.id, secret); await refresh(); return profile; }, 'Profil configuré. Son accès fournisseur n’a pas encore été testé.');
            if (result) {
                setProfileId(result.id);
                setName('');
            }
            setBusy(false);
        }}>
        <Field label="Nom du profil"><input required value={name} onChange={e => setName(e.target.value)} placeholder="Mon profil de programmation"/></Field>
        <label className="check-field"><input type="checkbox" checked={custom} onChange={e => { setCustom(e.target.checked); setProvider(''); setModel(''); }}/> Fournisseur / modèle personnalisé</label>
        <Field label="Fournisseur">{custom ? <input required value={providerId} onChange={e => setProvider(e.target.value)} placeholder="Identifiant compatible OpenCode"/> : <select required value={providerId} onChange={e => { setProvider(e.target.value); setModel(catalog.data?.providers.find(p => p.id === e.target.value)?.models[0]?.id || ''); }}><option value="">Choisir dans le catalogue réel</option>{catalog.data?.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</Field>
        <Field label="Modèle">{custom ? <input required value={modelId} onChange={e => setModel(e.target.value)} placeholder="Identifiant du modèle"/> : <select required value={modelId} onChange={e => setModel(e.target.value)}><option value="">Choisir un modèle</option>{models.map(m => <option key={m.id} value={m.id}>{m.name} · {m.id}</option>)}</select>}</Field>
        {metadata && <div className="catalog-meta"><span>Contexte : {metadata.context?.toLocaleString('fr-FR') ?? 'non communiqué'}</span><span>Outils : {metadata.tools === undefined ? 'non communiqué' : metadata.tools ? 'oui' : 'non'}</span><span>Raisonnement : {metadata.reasoning === undefined ? 'non communiqué' : metadata.reasoning ? 'oui' : 'non'}</span><span>Coût catalogue : {metadata.cost !== undefined ? JSON.stringify(metadata.cost) : "non communiqué"}</span><small>Métadonnées de catalogue, pas un test d’accès ni une promesse de gratuité.</small></div>}
        <Field label="URL API personnalisée (facultative)"><input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} type="url" placeholder="https://… ou serveur local"/></Field>
        <Field label="Clé fournisseur" hint="Facultative pour un modèle local. Champ vidé dès l’envoi."><input type="password" value={apiKey} onChange={e => setKey(e.target.value)} autoComplete="off"/></Field>
        {vault && <div className="privacy-note"><ShieldCheck size={16}/><span>Coffre OS : {vault.available ? vault.backend : 'indisponible, aucune persistance non chiffrée'}</span></div>}
        {vault?.available && <label className="check-field"><input type="checkbox" checked={persist} onChange={e => setPersist(e.target.checked)}/> Conserver volontairement ce secret dans le coffre OS chiffré.</label>}
        <button className="primary" disabled={busy || !providerId || !modelId}>Enregistrer le profil</button>
      </form>
    </section><section><div className="panel-title"><h3>Profils configurés</h3><span className="badge">{bootstrap?.profiles.length ?? 0}</span></div>
      {!bootstrap?.profiles.length && <Empty title="Aucun profil" detail="Configurez un modèle avant de créer une session. Une configuration n’est pas une validation d’accès."/>}
      <div className="item-list">{bootstrap?.profiles.map(profile => <button key={profile.id} className={`profile-item ${profile.id === profileId ? 'selected' : ''}`} onClick={() => setProfileId(profile.id)}><div><strong>{profile.name}</strong><code>{profile.providerId} / {profile.modelId}</code></div><span className="badge">{profile.hasSecret ? 'Secret en mémoire' : 'Sans secret mémoire'}</span></button>)}</div>
      {selected && <div className="form-panel secret-panel"><h3>{selected.name}</h3><p className="small">Aucun secret brut n’est renvoyé à l’interface. Un test réel peut consommer le quota du fournisseur.</p><button className="secondary" disabled={busy} onClick={async () => { if (!api || !await confirm('Tester l’accès réel ?', `Un appel authentifié pourra être envoyé au fournisseur ${selected.providerId} et consommer du quota.`))
            return; setBusy(true); const result = await act(() => api.request<{
            ok: boolean;
            detail: string;
        }>(`/profiles/${selected.id}/test`, 'POST')); if (result) {
            notify(`${result.ok ? 'Test confirmé' : 'Test refusé'} : ${result.detail}`, result.ok ? 'success' : 'error');
        } setBusy(false); }}><FlaskConical size={15}/> Tester le fournisseur</button>
        <Field label="Nouvelle clé pour rotation"><input type="password" value={rotation} onChange={e => setRotation(e.target.value)} autoComplete="off"/></Field><div className="button-row"><button className="secondary" disabled={busy || !rotation} onClick={() => void secretAction('rotate')}>Remplacer la clé</button><button className="danger" disabled={busy} onClick={() => void secretAction('delete')}><Trash2 size={14}/>Supprimer</button></div>
        {vault?.available && <button className="secondary" disabled={busy} onClick={() => void secretAction('load')}>Charger explicitement depuis le coffre OS</button>}
      </div>}
    </section></div>
  </div>;
}
