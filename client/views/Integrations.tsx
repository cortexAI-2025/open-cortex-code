import { useState } from 'react';
import { Plug, Globe, Trash2, FlaskConical } from 'lucide-react';
import { projectRoute, useResource } from '../api';
import { useApp } from '../state';
import { Empty, ErrorBox, Field, JsonResult, Loading, SectionHeading } from '../components/ui';
interface Mcp {
    id: string;
    name: string;
    type: 'local' | 'remote';
    url?: string;
    command?: string[];
    hasSecret: boolean;
    status: {
        status: string;
        error?: string;
    } | null;
}
interface RestApi {
    id: string;
    name: string;
    baseUrl: string;
    method: 'GET' | 'HEAD';
    path: string;
    hasSecret: boolean;
    allowLoopback: boolean;
}
function publicHeaders(raw: string): Record<string, string> {
    const value: unknown = raw.trim() ? JSON.parse(raw) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('En-têtes : objet JSON requis.');
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (!['accept', 'accept-language', 'content-type'].includes(key.toLowerCase()) || typeof entry !== 'string' || /[\r\n\0]/.test(entry))
            throw new Error('Seuls accept, accept-language et content-type publics sont autorisés. Aucun secret dans ce JSON.');
        result[key.toLowerCase()] = entry;
    }
    return result;
}
export function Integrations() {
    const { api, projectId, project, remote, act, confirm } = useApp();
    const [tab, setTab] = useState<'mcp' | 'apis'>('mcp');
    const mcp = useResource<Mcp[]>(api, projectId ? projectRoute(projectId, 'mcp') : null, 7000);
    const rest = useResource<RestApi[]>(api, projectId ? projectRoute(projectId, 'apis') : null);
    const [name, setName] = useState('');
    const [type, setType] = useState<'local' | 'remote'>('remote');
    const [url, setUrl] = useState('');
    const [command, setCommand] = useState('');
    const [method, setMethod] = useState<'GET' | 'HEAD'>('GET');
    const [path, setPath] = useState('/');
    const [headers, setHeaders] = useState('');
    const [secretName, setSecretName] = useState('authorization');
    const [secret, setSecret] = useState('');
    const [allowLoopback, setAllowLoopback] = useState(false);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<unknown>(null);
    const perform = async (resource: string, action: string, title: string, detail: string) => {
        if (!api || !await confirm(title, detail))
            return;
        setBusy(true);
        const value = await act(() => api.request(projectRoute(projectId, resource), action, { confirm: true }));
        if (value)
            setResult(value);
        mcp.refresh();
        rest.refresh();
        setBusy(false);
    };
    return <div className="page-scroll management-page"><SectionHeading index="06" title="MCP & API" detail="Connexions choisies explicitement. Aucun service préconfiguré, aucun secret dans les paramètres publics."/>
    <div className="sub-tabs"><button className={tab === 'mcp' ? 'active' : ''} onClick={() => { setTab('mcp'); setSecret(''); setResult(null); }}><Plug size={15}/>Serveurs MCP</button><button className={tab === 'apis' ? 'active' : ''} onClick={() => { setTab('apis'); setSecret(''); setResult(null); }}><Globe size={15}/>API REST</button></div>
    <div className="split-management"><section><ErrorBox error={tab === 'mcp' ? mcp.error : rest.error} retry={tab === 'mcp' ? mcp.refresh : rest.refresh}/>{(tab === 'mcp' ? mcp.loading : rest.loading) && <Loading />}
      {tab === 'mcp' ? <div className="item-list">{mcp.data?.map(item => <div className="integration-item" key={item.name}><header><Plug size={17}/><strong>{item.name}</strong><span className={`badge ${item.status?.status === 'connected' ? 'positive' : ''}`}>{item.status?.status || 'État moteur non confirmé'}</span></header><code>{item.type === 'local' ? item.command?.join(' ') : item.url}</code><small>{item.hasSecret ? 'Secret mémoire présent' : 'Aucun secret mémoire'}</small>{item.status?.error && <ErrorBox error={item.status.error}/>}<div className="button-row"><button className="secondary" disabled={busy || !project?.trusted || !item.id} onClick={() => void perform(`mcp/${encodeURIComponent(item.name)}/connect`, 'POST', 'Connecter ce serveur MCP ?', `${item.type === 'local' ? 'Une commande locale pourra démarrer.' : 'Une requête HTTPS sera envoyée au serveur choisi.'} Les outils MCP sont interdits en Ask et Plan. Ce test ne confère aucune permission permanente.`)}><Plug size={13}/>Connecter & vérifier</button><button className="danger" disabled={busy || !item.id} onClick={() => void perform(`mcp/${encodeURIComponent(item.name)}`, 'DELETE', 'Supprimer la connexion MCP ?', 'Le serveur sera retiré du moteur et ses secrets mémoire seront supprimés.')}><Trash2 size={13}/>Retirer</button></div></div>)}{mcp.data?.length === 0 && <Empty title="Aucun serveur MCP" detail="Ajoutez votre propre serveur. Le statut connecté n’apparaîtra qu’après une poignée de main moteur réelle."/>}</div> : <div className="item-list">{rest.data?.map(item => <div className="integration-item" key={item.id}><header><Globe size={17}/><strong>{item.name}</strong><span className="badge">CONFIGURÉ · NON PRÉSUMÉ TESTÉ</span></header><code>{item.method} {item.baseUrl}{item.path}</code><small>{item.hasSecret ? 'Bearer en mémoire' : 'Sans secret'} · {item.allowLoopback ? 'Loopback approuvé' : 'HTTPS public'}</small><div className="button-row"><button className="secondary" disabled={busy} onClick={() => void perform(`apis/${item.id}/test`, 'POST', 'Tester cet endpoint REST ?', `${item.method} ${item.baseUrl}${item.path} sera appelé depuis votre connecteur. Seules GET/HEAD sont permises ; aucune mutation distante ni redirection implicite.`)}><FlaskConical size={13}/>Tester réellement</button><button className="danger" disabled={busy} onClick={() => void perform(`apis/${item.id}`, 'DELETE', 'Supprimer ce profil REST ?', 'Configuration locale et secret mémoire seront supprimés.')}><Trash2 size={13}/>Retirer</button></div></div>)}{rest.data?.length === 0 && <Empty title="Aucune API configurée" detail="Configurez une URL, une méthode sûre et un endpoint. Le test réseau est une action séparée."/>}</div>}
      {result !== null && <section className="form-panel"><h3>Dernière réponse réelle du connecteur</h3><JsonResult value={result}/></section>}
    </section>{remote ? <section className="form-panel"><div className="panel-title"><Plug size={17}/><h3>Configuration réservée au client local</h3></div><p>Les formulaires pouvant recevoir une clé API, des headers MCP secrets ou un environnement secret ne sont pas présentés à cette origine HTTPS. Utilisez l’interface locale pour ajouter ou modifier des credentials.</p></section> : <section className="form-panel"><h3>{tab === 'mcp' ? 'Ajouter un serveur MCP' : 'Configurer une API REST'}</h3><form onSubmit={async (e) => {
            e.preventDefault();
            if (!api || !await confirm('Enregistrer cette connexion ?', `La configuration et, si fourni, le secret seront transmis uniquement au connecteur ${api.connection.url}. ${tab === 'mcp' ? 'Le serveur est enregistré désactivé, pas déclaré connecté.' : 'Aucun appel REST n’est effectué par cet enregistrement.'}`))
                return;
            setBusy(true);
            const key = secret;
            setSecret('');
            const value = await act(async () => {
                let body: Record<string, unknown>;
                if (tab === 'apis')
                    body = { name, baseUrl: url, method, path, headers: publicHeaders(headers), allowLoopback, ...(key ? { apiKey: key } : {}) };
                else if (type === 'local') {
                    const args: unknown = JSON.parse(command);
                    if (!Array.isArray(args) || !args.length || args.some(arg => typeof arg !== 'string' || !arg.trim()))
                        throw new Error('La commande MCP doit être un tableau JSON de chaînes non vides, sans shell implicite.');
                    if (key && !/^[A-Z][A-Z0-9_]{0,63}$/.test(secretName))
                        throw new Error('Nom de variable de secret MCP invalide : utilisez des majuscules et underscores.');
                    body = { name, type, command: args, confirm: true, ...(key ? { secretEnvironment: { [secretName]: key } } : {}) };
                }
                else
                    body = { name, type, url, headers: publicHeaders(headers), confirm: true, ...(key ? { secretHeaders: { [secretName]: key } } : {}) };
                return api.request(projectRoute(projectId, tab), 'POST', body);
            });
            if (value) {
                setResult(value);
                setName('');
            }
            mcp.refresh();
            rest.refresh();
            setBusy(false);
        }}>
      <Field label={tab === 'mcp' ? 'Nom (slug minuscules)' : 'Nom du profil'}><input required value={name} onChange={e => setName(e.target.value)} pattern={tab === 'mcp' ? '[a-z0-9]+(-[a-z0-9]+)*' : undefined}/></Field>
      {tab === 'mcp' && <Field label="Transport"><select value={type} onChange={e => { setType(e.target.value as 'local' | 'remote'); setSecretName(e.target.value === 'local' ? 'SERVICE_TOKEN' : 'authorization'); setSecret(''); }}><option value="remote">Remote HTTPS</option><option value="local">Commande locale (stdio)</option></select></Field>}
      {tab === 'mcp' && type === 'local' ? <Field label="Commande : tableau JSON d’arguments" hint="Aucun secret dans argv. L’exécutable et chaque argument sont des éléments séparés."><textarea required value={command} onChange={e => setCommand(e.target.value)} placeholder={'["executable", "argument"]'} className="mono"/></Field> : <Field label={tab === 'apis' ? 'URL de base HTTPS ou loopback approuvé' : 'URL du serveur HTTPS public'}><input required type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…"/></Field>}
      {tab === 'apis' && <><div className="two-fields"><Field label="Méthode"><select value={method} onChange={e => setMethod(e.target.value as 'GET' | 'HEAD')}><option>GET</option><option>HEAD</option></select></Field><Field label="Endpoint / paramètres publics"><input required value={path} onChange={e => setPath(e.target.value)} placeholder="/endpoint?parametre=valeur"/></Field></div><label className="check-field"><input type="checkbox" checked={allowLoopback} onChange={e => setAllowLoopback(e.target.checked)}/> J’approuve explicitement le réseau loopback de cette API.</label></>}
      {(tab === 'apis' || type === 'remote') && <Field label="Headers publics (JSON facultatif)" hint="Allowlist : accept, accept-language, content-type. Aucun token dans ce JSON."><textarea className="mono" value={headers} onChange={e => setHeaders(e.target.value)} placeholder="{}"/></Field>}
      {tab === 'mcp' && <Field label={type === 'local' ? 'Nom de variable secrète (env)' : 'Header secret'}>{type === 'local' ? <input value={secretName} onChange={e => setSecretName(e.target.value)}/> : <select value={secretName} onChange={e => setSecretName(e.target.value)}><option value="authorization">Authorization (inclure Bearer si nécessaire)</option><option value="x-api-key">X-API-Key</option><option value="api-key">API-Key</option></select>}</Field>}
      <Field label={tab === 'apis' ? 'Clé API Bearer (facultative)' : 'Valeur secrète (facultative)'} hint="Transmise séparément, gardée en mémoire du connecteur. Jamais en configuration publique."><input type="password" value={secret} onChange={e => setSecret(e.target.value)} autoComplete="off"/></Field><button className="primary" disabled={busy || tab === 'mcp' && !project?.trusted}>Enregistrer sans auto-connecter</button>
    </form></section>}</div>
  </div>;
}
