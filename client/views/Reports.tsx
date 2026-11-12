import { useState } from 'react';
import { RefreshCw, Download } from 'lucide-react';
import type { HistoryEvent } from '../../shared/contracts';
import { dateLabel, projectRoute, useResource } from '../api';
import { useApp } from '../state';
import { Empty, ErrorBox, JsonResult, Loading, SectionHeading } from '../components/ui';
import { DeliveryDocument, type DeliveryReport } from './DeliveryDocument';
export function Reports({ delivery = false }: {
    delivery?: boolean;
}) {
    const { api, projectId, project } = useApp();
    const [filter, setFilter] = useState('');
    const history = useResource<HistoryEvent[]>(api, projectId && !delivery ? projectRoute(projectId, 'history') : null, 10000);
    const report = useResource<DeliveryReport>(api, projectId && delivery ? projectRoute(projectId, 'delivery') : null);
    const source = delivery ? report : history;
    const download = () => { if (!report.data)
        return; const blob = new Blob([JSON.stringify(report.data, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${project?.name || 'projet'}-rapport-cortex.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    return <div className="page-scroll management-page"><SectionHeading index="10" title={delivery ? 'Livraison & rapport' : 'Historique du projet'} detail={delivery ? 'Résumé machine du connecteur : changements, commandes de test réellement exécutées et problèmes restants.' : 'Événements locaux réellement enregistrés. Une demande envoyée au moteur n’est pas une tâche terminée.'} action={<div className="button-row">{delivery && <button className="secondary" disabled={!report.data} onClick={download}><Download size={14}/>Exporter le rapport JSON</button>}<button className="secondary" onClick={source.refresh}><RefreshCw size={14}/>Actualiser</button></div>}/><ErrorBox error={source.error} retry={source.refresh}/>{source.loading && <Loading />}
    {delivery ? <>{report.data !== null && <DeliveryDocument report={report.data}/>}<div className="info-note">Ce rapport reflète les données retournées, pas une certification. Aucun ZIP, APK/AAB, push, PR ou compilation ne sera annoncé sans résultat réel. Les artefacts dépendent de votre toolchain locale et des commandes autorisées.</div></> : <><input className="history-search" aria-label="Filtrer l’historique" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filtrer les événements locaux…"/>{history.data?.length === 0 && <Empty title="Aucun événement enregistré" detail="Les ouvertures, décisions et actions réelles seront consignées par le connecteur."/>}<div className="history-timeline">{[...(history.data || [])].reverse().filter(event => `${event.title} ${event.detail} ${event.kind}`.toLowerCase().includes(filter.toLowerCase())).map(event => <article key={event.id}><div className="timeline-marker"/><header><span className="badge">{event.kind}</span><time>{dateLabel(event.createdAt)}</time></header><h3>{event.title}</h3><p>{event.detail}</p></article>)}</div></>}
  </div>;
}
