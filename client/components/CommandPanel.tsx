import { useState } from 'react';
import { Play, Terminal, CheckCircle2, XCircle } from 'lucide-react';
import type { CommandResult } from '../../shared/contracts';
import { dateLabel, projectRoute, useResource } from '../api';
import { useApp } from '../state';
import { Empty, ErrorBox, Loading } from './ui';
interface StoredCommand extends CommandResult {
    kind: 'command' | 'test';
    timedOut?: boolean;
    truncated?: boolean;
    signal?: string | null;
}
export function CommandPanel({ tests = false }: {
    tests?: boolean;
}) {
    const { api, project, projectId, act, confirm } = useApp();
    const [command, setCommand] = useState('');
    const [busy, setBusy] = useState(false);
    const results = useResource<StoredCommand[]>(api, projectId ? projectRoute(projectId, 'commands') : null);
    const records = tests ? results.data?.filter(result => result.kind === 'test') : results.data;
    return <div className="command-panel"><div className="runner-warning"><Terminal size={15}/><span>{tests ? 'Tests explicitement exécutés via ce runner (kind:test). Leur sortie et code de retour font foi, sans extrapolation E2E.' : 'Runner de commandes bornées, pas un terminal PTY. Aucun shell interactif ni serveur persistant.'}</span><span className="badge">{project?.trusted ? 'PROJET APPROUVÉ' : 'EXÉCUTION BLOQUÉE'}</span></div>
    <form className="command-form" onSubmit={async (e) => {
            e.preventDefault();
            if (!api || !project?.trusted || !command.trim())
                return;
            if (!await confirm(tests ? 'Exécuter cette commande de test ?' : 'Exécuter cette commande locale ?', `Dans ${project.path} :\n${command}\nLe code s’exécutera avec les droits de votre utilisateur. Pas de sandbox OS. Durée et sortie bornées par le connecteur.`))
                return;
            setBusy(true);
            await act(() => api.request<StoredCommand>(projectRoute(projectId, 'commands'), 'POST', { command, kind: tests ? 'test' : 'command', confirm: true }), 'Commande terminée. Consultez son code de retour.');
            results.refresh();
            setBusy(false);
        }}><span className="command-prompt">›</span><input aria-label={tests ? 'Commande de test' : 'Commande locale'} value={command} onChange={e => setCommand(e.target.value)} placeholder={tests ? 'Saisir votre commande de test réelle…' : 'Saisir une commande explicite…'} disabled={!project?.trusted || busy} spellCheck={false}/><button className="primary" disabled={!project?.trusted || busy || !command.trim()}><Play size={13}/>{busy ? 'Exécution…' : 'Exécuter'}</button></form>
    {!project?.trusted && <p className="small">Exécution refusée pour ce projet non approuvé. N’approuvez que du code examiné ; pour du code non fiable, utilisez un environnement isolé externe.</p>}<ErrorBox error={results.error} retry={results.refresh}/>{results.loading && <Loading />}
    {!records?.length && !results.loading && !results.error && <Empty title={tests ? 'Aucun résultat de test enregistré' : 'Aucune commande exécutée'} detail="Les sorties et codes de retour apparaîtront uniquement après une exécution réelle."/>}
    {[...(records || [])].reverse().map(result => <details className="command-result" key={result.id} open><summary>{result.exitCode === 0 && !result.timedOut ? <CheckCircle2 size={15}/> : <XCircle size={15}/>}<code>{result.command}</code><span className={result.exitCode === 0 && !result.timedOut ? 'result-pass' : 'result-fail'}>{result.exitCode === null ? 'Code non disponible' : `Code ${result.exitCode}`}{result.timedOut ? ' · délai dépassé' : ''}{result.truncated ? ' · sortie tronquée' : ''}</span><small>{result.durationMs} ms · {dateLabel(result.createdAt)}</small></summary><pre>{result.output || 'Aucune sortie renvoyée.'}</pre></details>)}
  </div>;
}
