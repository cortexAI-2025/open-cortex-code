import { useEffect, useRef, useState } from 'react';
import { Cable, ShieldCheck, Unplug, Check, X, RefreshCw } from 'lucide-react';
import { useApp } from '../state';
import { isLoopback, type LocalApi } from '../api';
import { Field } from './ui';
import '../pairing.css';

interface PairingRequest {
    id: string;
    origin: string;
    state: 'pending' | 'approved' | 'paired' | 'denied' | 'expired' | 'revoked';
    createdAt: string;
    expiresAt: string;
}
interface PairingControl { enabled: boolean; enabledUntil: string | null }

function LocalPairings({ api }: { api: LocalApi }) {
    const { confirm, act } = useApp();
    const [rows, setRows] = useState<PairingRequest[]>([]);
    const [control, setControl] = useState<PairingControl>({ enabled: false, enabledUntil: null });
    const [error, setError] = useState('');
    const [revision, setRevision] = useState(0);
    const [controlBusy, setControlBusy] = useState(false);
    useEffect(() => {
        let active = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const refresh = async () => {
            try {
                const [result, settings] = await Promise.all([
                    api.request<PairingRequest[]>('/pair/requests', 'GET', undefined, AbortSignal.timeout(5000)),
                    api.request<PairingControl>('/pair/control', 'GET', undefined, AbortSignal.timeout(5000)),
                ]);
                if (active) { setRows(result); setControl(settings); setError(''); }
            }
            catch (e) { if (active) setError(e instanceof Error ? e.message : 'Impossible de lire les demandes locales.'); }
            if (active) timer = setTimeout(refresh, 1800);
        };
        void refresh();
        return () => { active = false; clearTimeout(timer); };
    }, [api, revision]);
    const toggleRemoteRequests = async () => {
        const enable = !control.enabled;
        if (enable && !await confirm('Autoriser les demandes HTTPS pendant 5 minutes ?', 'Toute nouvelle demande restera soumise à approbation locale. L’ouverture temporaire est visible dans ce panneau et se referme automatiquement après cinq minutes. Les sessions déjà jumelées gardent leur expiration propre.')) return;
        setControlBusy(true);
        const result = await act(() => api.request<PairingControl>('/pair/control', 'POST', { enabled: enable, confirm: true }), enable ? 'Nouvelles demandes HTTPS autorisées pendant cinq minutes.' : 'Nouvelles demandes HTTPS désactivées.');
        if (result) { setControl(result); setRevision(n => n + 1); }
        setControlBusy(false);
    };
    const decide = async (item: PairingRequest, approve: boolean) => {
        if (approve && !await confirm(`Autoriser ${item.origin} ?`, 'Cette origine HTTPS recevra un jeton temporaire lié à son origine exacte. Son JavaScript pourra lire les fichiers et les messages que vous utilisez dans l’interface et déclencher les actions auxquelles vous consentez. La gestion et la saisie des clés BYOK restent réservées à cette interface locale. N’autorisez qu’une origine de confiance.')) return;
        const result = await act(() => api.request(`/pair/requests/${encodeURIComponent(item.id)}/${approve ? 'approve' : 'deny'}`, 'POST', { confirm: true }), approve ? 'Origine HTTPS approuvée pour une session temporaire.' : 'Demande refusée.');
        if (result) setRevision(n => n + 1);
    };
    const revoke = async (item: PairingRequest) => {
        if (!await confirm(`Révoquer ${item.origin} ?`, 'Le jeton distant deviendra immédiatement inutilisable. La page devra être jumelée à nouveau.')) return;
        const result = await act(() => api.request(`/pair/sessions/${encodeURIComponent(item.id)}`, 'DELETE', { confirm: true }), 'Session distante révoquée.');
        if (result) setRevision(n => n + 1);
    };
    const relevant = rows.filter(item => ['pending', 'approved', 'paired'].includes(item.state));
    return <section className="pairing-local"><div className="panel-title"><ShieldCheck size={17}/><h3>Demandes de sites HTTPS</h3><button className={control.enabled ? 'secondary' : 'primary'} disabled={controlBusy} onClick={() => void toggleRemoteRequests()}>{control.enabled ? 'Fermer les nouvelles demandes' : 'Autoriser 5 min'}</button><button className="icon-button" aria-label="Actualiser les demandes" onClick={() => setRevision(n => n + 1)}><RefreshCw size={14}/></button></div>
      <p>{control.enabled ? `Les nouvelles demandes sont ouvertes jusqu’à ${new Date(control.enabledUntil!).toLocaleTimeString('fr-FR')}.` : 'Les demandes HTTPS sont fermées par défaut. Ouvrez-les pendant cinq minutes uniquement au moment du jumelage.'} Toute demande créée reste soumise à approbation ici; comparez l’origine complète.</p>
      {error && <p className="pairing-error" role="status">{error}</p>}
      {!relevant.length && <p className="small">Aucune demande ni session distante active.</p>}
      <div className="pairing-list">{relevant.map(item => <article key={item.id} className="pairing-row"><div><code>{item.origin}</code><small>{item.state === 'pending' ? `Demande · expire ${new Date(item.expiresAt).toLocaleTimeString('fr-FR')}` : `Jeton temporaire · ${item.state}`}</small></div>
        {item.state === 'pending' ? <div className="button-row"><button className="primary" onClick={() => void decide(item, true)}><Check size={13}/>Autoriser</button><button className="danger" onClick={() => void decide(item, false)}><X size={13}/>Refuser</button></div> : <button className="danger" onClick={() => void revoke(item)}>Révoquer</button>}
      </article>)}</div>
    </section>;
}

function HostedPairing({ connect, connecting }: { connect: (url: string, token: string, remote?: boolean, pairingId?: string) => Promise<boolean>; connecting: boolean }) {
    const [url, setUrl] = useState('http://127.0.0.1:4000');
    const [consent, setConsent] = useState(false);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');
    const controller = useRef<AbortController | null>(null);
    useEffect(() => () => controller.current?.abort(), []);
    const requestPairing = async () => {
        setError(''); setStatus('');
        if (location.protocol !== 'https:') { setError('Le pairing distant est disponible uniquement depuis une origine HTTPS sécurisée.'); return; }
        if (!consent) { setError('Confirmez que vous faites confiance à cette origine HTTPS.'); return; }
        let target: URL;
        try { target = new URL(url); } catch { setError('Saisissez une URL de connecteur valide.'); return; }
        if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/' || target.search || target.hash || target.username || target.password) {
            setError('Seule une URL HTTP loopback littérale `http://127.0.0.1:PORT` est admise. Aucun hostname, tunnel ou proxy distant.'); return;
        }
        const abort = new AbortController(); controller.current = abort; setBusy(true);
        try {
            setStatus('Demande envoyée au connecteur; vérifiez ensuite l’origine dans son interface locale.');
            const requestResponse = await fetch(`${target.origin}/api/pair/requests`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: abort.signal });
            if (!requestResponse.ok) throw new Error(requestResponse.status === 403 ? 'Le pairing distant est désactivé. Ouvrez les demandes pendant cinq minutes dans l’interface locale, puis réessayez.' : `Demande refusée par le connecteur (HTTP ${requestResponse.status}).`);
            const request = await requestResponse.json() as { id: string; expiresAt: string };
            const deadline = Date.now() + 115_000;
            while (Date.now() < deadline && !abort.signal.aborted) {
                const response = await fetch(`${target.origin}/api/pair/requests/${encodeURIComponent(request.id)}`, { headers: { Accept: 'application/json' }, mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: abort.signal });
                if (!response.ok) throw new Error('La demande a expiré, a été refusée ou l’origine a perdu son autorisation. Vérifiez l’écran local du connecteur.');
                const result = await response.json() as { state: string; token?: string };
                if (result.state === 'paired' && result.token) {
                    setStatus('Approbation reçue. Vérification du connecteur local…');
                    if (!await connect(target.origin, result.token, true, request.id)) throw new Error('Le jeton a été consommé mais le connecteur n’a pas terminé la vérification. Révoquez cette session depuis l’interface locale puis recommencez.');
                    setStatus('Connecteur local associé. Le jeton reste uniquement en mémoire de cet onglet.');
                    return;
                }
                if (result.state === 'denied' || result.state === 'expired' || result.state === 'revoked') throw new Error('Demande refusée ou expirée par le connecteur local.');
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(resolve, 1200);
                    abort.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Annulé', 'AbortError')); }, { once: true });
                });
            }
            if (!abort.signal.aborted) throw new Error('Délai de pairing dépassé. Relancez une demande et approuvez-la depuis l’interface locale.');
        }
        catch (e) {
            if (!abort.signal.aborted) setError(e instanceof Error && e.name === 'TypeError' ? 'Le navigateur a bloqué l’accès au réseau local. Vérifiez sa permission Local Network Access, le port et CORS; aucune protection navigateur n’est contournée.' : e instanceof Error ? e.message : 'Échec du pairing.');
        }
        finally { if (controller.current === abort) controller.current = null; setBusy(false); }
    };
    const cancel = () => controller.current?.abort();
    return <section className="connection-panel"><div className="panel-title"><Cable size={18}/><h3>Associer un connecteur local</h3><span className="badge">HTTPS → LOOPBACK</span></div>
      <p>La page HTTPS appelle directement votre connecteur sur cet appareil. Aucun backend ni relais cloud n’est utilisé.</p>
      <Field label="URL du connecteur local" hint="L’adresse est uniquement loopback littérale; le connecteur doit tourner sur votre appareil."><input required value={url} onChange={e => setUrl(e.target.value)} autoComplete="off" spellCheck={false}/></Field>
      <label className="check-field"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/> Je fais confiance à l’origine exacte <code>{location.origin}</code> pour voir les fichiers et messages utilisés dans cette interface.</label>
      {error && <div className="error-box" role="alert"><span>{error}</span></div>}{status && <p className="pairing-status" role="status">{status}</p>}
      {busy ? <button className="secondary" onClick={cancel}>Annuler l’attente</button> : <button className="primary" disabled={!consent || connecting} onClick={() => void requestPairing()}><Cable size={15}/>Demander l’approbation locale</button>}
      <div className="privacy-note"><ShieldCheck size={15}/><span>L’interface distante ne peut pas créer, lire ou modifier les secrets BYOK. Les clés se configurent uniquement depuis l’application locale. Le contenu de projet consulté par JavaScript distant demeure visible à cette origine : n’approuvez qu’un hébergeur de confiance.</span></div>
    </section>;
}

export function ConnectionPanel() {
    const { api, connected, connecting, connect, disconnect, confirm, unsaved, notify } = useApp();
    const [url, setUrl] = useState('http://127.0.0.1:4000');
    const [token, setToken] = useState('');
    const [consent, setConsent] = useState(false);
    const hosted = !window.cortexDesktop && !isLoopback(location.hostname);
    const localConnector = api && !api.connection.remote && isLoopback(new URL(api.connection.url).hostname);
    if (!api && hosted) return <HostedPairing connect={connect} connecting={connecting}/>;
    return <><section className="connection-panel">
      <div className="panel-title"><Cable size={18}/><h3>{api ? api.connection.remote ? 'Connecteur local · origine distante' : 'Votre connecteur local' : 'Associer votre atelier'}</h3><span className={`badge ${connected ? 'positive' : ''}`}>{connected ? 'Associé · accessible' : api ? 'Associé · inaccessible' : 'Déconnecté'}</span></div>
      {api ? <><p className="mono endpoint">{api.connection.url}</p><p>{connected ? api.connection.remote ? 'Jeton d’origine temporaire en mémoire de cet onglet. Les secrets restent configurables uniquement depuis l’interface locale.' : 'Jeton en mémoire. Les clés fournisseur sont transmises uniquement à ce connecteur loopback, puis au fournisseur sélectionné par votre moteur.' : 'Le connecteur ne répond plus. Les API indisponibles affichent leur erreur.'}</p><button className="secondary" onClick={async () => { if (await confirm('Déconnecter l’atelier ?', `Le jeton sera oublié par cette interface.${api.connection.remote ? ' La session sera aussi révoquée sur le connecteur local.' : ' Cela n’arrête pas les tâches déjà lancées sur le connecteur.'}${unsaved ? ' Vos brouillons non enregistrés seront abandonnés.' : ''}`)) { if (api.connection.remote && api.connection.pairingId) { try { await api.request(`/pair/sessions/${encodeURIComponent(api.connection.pairingId)}`, 'DELETE', { confirm: true }); } catch { notify('Interface déconnectée; vérifiez les sessions distantes depuis le panneau local si la révocation n’a pas atteint le connecteur.', 'error'); } } disconnect(); } }}><Unplug size={15}/> Déconnecter & oublier le pairing</button></> : <form onSubmit={async e => { e.preventDefault(); if (await connect(url, token)) { setToken(''); setUrl(new URL(url).origin); setConsent(false); } }}>
        <Field label="URL du connecteur ou lien de pairing"><input required type="text" value={url} onChange={e => setUrl(e.target.value)} placeholder="http://127.0.0.1:4000/#token=…" autoComplete="off" spellCheck={false}/></Field>
        <Field label="Jeton de pairing" hint="Facultatif si présent dans le fragment d’un lien local. Jamais enregistré dans le navigateur."><input type="password" value={token} onChange={e => setToken(e.target.value)} autoComplete="off" placeholder="Jeton affiché au lancement local"/></Field>
        <label className="check-field"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/> Je choisis explicitement ce connecteur sur mon appareil.</label>
        <button className="primary" disabled={!consent || connecting}><Cable size={16}/>{connecting ? 'Vérification du connecteur…' : 'Associer le connecteur'}</button>
      </form>}
      <div className="privacy-note"><ShieldCheck size={15}/><span>Pas de proxy cloud, pas de clé en localStorage. Une Preview HTTPS peut requérir l’autorisation réseau local du navigateur; aucune protection n’est désactivée.</span></div>
    </section>{localConnector && connected && <LocalPairings api={api!}/>}</>;
}
