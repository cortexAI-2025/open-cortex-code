import { useState } from 'react';
import { GitBranch, Archive, RotateCcw, RefreshCw } from 'lucide-react';
import { RequestError, dateLabel, projectRoute, useResource } from '../api';
import { useApp } from '../state';
import { Empty, ErrorBox, Loading } from './ui';
interface GitState {
    available: boolean;
    branch: string;
    status: string;
    log: {
        hash: string;
        message: string;
        date: string;
    }[];
    diff: string;
    truncated?: boolean;
}
interface Checkpoint {
    id: string;
    message?: string;
    createdAt?: string;
    files?: {
        path: string;
        hash: string;
    }[];
    excluded?: string[];
}
interface RestorePreview {
    checkpoint: Checkpoint;
    hashes: Record<string, string | null>;
}
export function GitPanel() {
    const { api, projectId, profileId, act, confirm, setSession, setView, unsaved } = useApp();
    const [tab, setTab] = useState<'diff' | 'log' | 'checkpoints' | 'github'>('diff');
    const [branch, setBranch] = useState('');
    const [busy, setBusy] = useState(false);
    const [preview, setPreview] = useState<RestorePreview | null>(null);
    const git = useResource<GitState>(api, projectId ? projectRoute(projectId, 'git') : null);
    const checkpoints = useResource<Checkpoint[]>(api, projectId ? projectRoute(projectId, 'git/checkpoints') : null);
    const github = useResource<unknown>(api, projectId && tab === 'github' ? projectRoute(projectId, 'github') : null);
    const mutate = async (resource: string, body: Record<string, unknown>, title: string, detail: string) => {
        if (!api || !projectId || !await confirm(title, detail))
            return;
        setBusy(true);
        await act(() => api.request(projectRoute(projectId, resource), 'POST', { ...body, confirm: true }), 'Opération Git confirmée par le connecteur.');
        git.refresh();
        checkpoints.refresh();
        setBusy(false);
    };
    const restore = async (checkpoint: Checkpoint, hashes?: Record<string, string | null>) => {
        if (!api || !await confirm(hashes ? 'Restaurer après examen des fichiers ?' : 'Préparer l’aperçu de restauration ?', hashes ? `Les fichiers listés seront remplacés par le checkpoint ${checkpoint.message || checkpoint.id}. Les hashes actuels seront vérifiés. Les nouveaux fichiers sont conservés, l’index et la branche inchangés. ${unsaved ? 'Attention : des brouillons Monaco non enregistrés existent ; rechargez-les ensuite pour éviter une sauvegarde périmée.' : ''}` : 'Cette première requête demande l’aperçu de concurrence. Aucun fichier ne sera remplacé tant que vous n’aurez pas examiné les chemins et confirmé avec leurs hashes.'))
            return;
        setBusy(true);
        await act(async () => {
            try {
                await api.request(projectRoute(projectId, 'git/restore'), 'POST', { checkpointId: checkpoint.id, confirm: true, ...(hashes ? { expectedHashes: hashes } : {}) });
                setPreview(null);
                git.refresh();
                checkpoints.refresh();
            }
            catch (error) {
                if (error instanceof RequestError && error.payload.code === 'RESTORE_PREVIEW_REQUIRED' && error.payload.expectedHashes && typeof error.payload.expectedHashes === 'object') {
                    setPreview({ checkpoint, hashes: error.payload.expectedHashes as Record<string, string | null> });
                    return;
                }
                throw error;
            }
        });
        setBusy(false);
    };
    return <div className="git-panel"><div className="git-toolbar"><span><GitBranch size={15}/>{git.data?.available ? git.data.branch : 'Git non confirmé'}</span><div className="button-row"><button className="secondary" disabled={busy || !git.data?.available} onClick={() => void mutate('git/checkpoint', { message: 'Point de sécurité manuel' }, 'Créer un checkpoint local ?', 'Un instantané non destructif sera créé sans écraser l’index Git. Aucun push automatique.')}><Archive size={13}/>Checkpoint</button><button className="icon-button" aria-label="Actualiser Git" title="Actualiser Git" onClick={git.refresh}><RefreshCw size={14}/></button></div></div>
    <div className="sub-tabs">{(['diff', 'log', 'checkpoints', 'github'] as const).map(item => <button key={item} className={item === tab ? 'active' : ''} onClick={() => setTab(item)}>{item === 'diff' ? 'Diff' : item === 'log' ? 'Commits' : item === 'checkpoints' ? 'Points de sécurité' : 'GitHub local'}</button>)}</div><ErrorBox error={git.error} retry={git.refresh}/>{git.loading && <Loading />}{git.data?.truncated && <div className="info-note">Sortie Git tronquée : le diff/historique affiché est incomplet.</div>}
    {git.data && !git.data.available && <Empty title="Ce dossier n’est pas un dépôt Git accessible" detail="Aucune initialisation ni création de branche n’est effectuée implicitement."/>}
    {tab === 'diff' && git.data?.available && <><pre className="git-status">{git.data.status || 'Aucune modification signalée par Git.'}</pre>{git.data.diff ? <pre className="diff-content">{git.data.diff.split('\n').map((line, i) => <span key={i} className={line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''}>{line}{'\n'}</span>)}</pre> : <p className="small">Aucun diff retourné. Les fichiers non suivis peuvent ne pas figurer dans le diff.</p>}<button className="secondary" disabled={!profileId || busy} onClick={async () => { if (!api || !await confirm('Analyser le diff avec le modèle ?', 'Le diff sera transmis au fournisseur du profil sélectionné, en lecture seule. L’analyse peut consommer du quota.'))
        return; setBusy(true); const session = await act(() => api.request<import('../../shared/contracts').CortexSession>(projectRoute(projectId, 'review'), 'POST', { profileId })); if (session) {
        setSession(session);
        setView('editor');
    } setBusy(false); }}>Demander une revue en lecture seule</button></>}
    {tab === 'log' && <><div className="item-list">{git.data?.log.map(item => <div className="commit-row" key={item.hash}><code>{item.hash.slice(0, 8)}</code><span>{item.message}</span><small>{dateLabel(item.date)}</small></div>)}</div><form className="inline-form" onSubmit={e => { e.preventDefault(); void mutate('git/branch', { name: branch }, 'Créer cette branche ?', `Une branche locale ${branch} sera créée sans checkout. Aucun push ni merge ne sera exécuté.`); }}><input value={branch} onChange={e => setBranch(e.target.value)} placeholder="Nom de la nouvelle branche" aria-label="Nom de branche" required/><button className="secondary" disabled={busy || !git.data?.available}>Créer une branche</button></form></>}
    {tab === 'checkpoints' && <><ErrorBox error={checkpoints.error} retry={checkpoints.refresh}/>{checkpoints.data?.length === 0 && <p className="small">Aucun checkpoint enregistré.</p>}{checkpoints.data?.map(item => <div className="checkpoint-row" key={item.id}><div><strong>{item.message || item.id}</strong><small>{dateLabel(item.createdAt)} · {item.files?.length ?? 0} fichiers · {item.excluded?.length ?? 0} exclus</small></div><button className="danger" disabled={busy} onClick={() => void restore(item)}><RotateCcw size={13}/>Examiner & restaurer</button></div>)}</>}
    {preview && <section className="form-panel restore-preview"><h3>Aperçu : fichiers qui seront restaurés</h3><p className="small">Hash actuel sur disque. Vérifiez chaque chemin ; la restauration sera refusée en cas de changement concurrent.</p><pre className="result-json">{Object.entries(preview.hashes).map(([path, hash]) => `${path}\n  ${hash || 'Absent sur disque'}`).join('\n')}</pre><div className="button-row"><button className="secondary" onClick={() => setPreview(null)}>Annuler</button><button className="danger" disabled={busy} onClick={() => void restore(preview.checkpoint, preview.hashes)}>Restaurer les chemins examinés</button></div></section>}
    {tab === 'github' && <><ErrorBox error={github.error} retry={github.refresh}/>{github.loading && <Loading />}{github.data !== null && <pre className="result-json">{JSON.stringify(github.data, null, 2)}</pre>}<p className="small">État du CLI gh local uniquement. PR/workflows en lecture ; aucun connecteur Manus, push ni merge automatique.</p></>}
  </div>;
}
