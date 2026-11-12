import { AlertTriangle, FileCode2, FlaskConical, GitBranch } from 'lucide-react';
import type { CommandResult } from '../../shared/contracts';
import { dateLabel } from '../api';
export interface DeliveryReport {
    generatedAt: string;
    gitAvailable: boolean;
    branch: string;
    files: {
        path: string;
        status: string;
    }[];
    diff: string;
    tests: (CommandResult & {
        timedOut?: boolean;
        truncated?: boolean;
        provenance?: string;
    })[];
    problems: string[];
    remaining: string[];
    testScope: string;
    commandsExecuted: number;
}
export function DeliveryDocument({ report }: {
    report: DeliveryReport;
}) {
    return <section className="delivery-document"><div className="delivery-summary"><div><GitBranch size={16}/><strong>{report.gitAvailable ? report.branch : 'Git indisponible'}</strong></div><small>Généré par le connecteur · {dateLabel(report.generatedAt)}</small><span className="badge">{report.commandsExecuted} commandes enregistrées</span></div>
    <div className="delivery-section"><h3><FileCode2 size={16}/>Fichiers signalés par Git <span className="badge">{report.files.length}</span></h3>{report.files.length ? <div className="delivery-files">{report.files.map(file => <div key={file.path}><code className="file-status">{file.status}</code><code>{file.path}</code></div>)}</div> : <p className="small">Aucun fichier modifié retourné par Git. Pas de déduction sur d’autres répertoires.</p>}</div>
    <div className="delivery-section"><h3><FlaskConical size={16}/>Tests réellement exécutés <span className="badge">{report.tests.length}</span></h3><p className="small">{report.testScope}</p>{report.tests.length === 0 && <p className="info-note">Aucun test explicitement exécuté. Aucune compilation ni réussite présumée.</p>}{report.tests.map(test => <details className="command-result" key={test.id}><summary><code>{test.command}</code><span className={test.exitCode === 0 && !test.timedOut ? 'result-pass' : 'result-fail'}>{test.exitCode === null ? 'Code non communiqué' : `Code ${test.exitCode}`}{test.timedOut ? ' · délai dépassé' : ''}{test.truncated ? ' · tronqué' : ''}</span><small>{test.durationMs} ms · {dateLabel(test.createdAt)}</small></summary><pre>{test.output}</pre></details>)}</div>
    <div className="delivery-section"><h3><AlertTriangle size={16}/>Problèmes & périmètre restant</h3>{report.problems.map((problem, index) => <p className="delivery-problem" key={index}>{problem}</p>)}<ul className="delivery-limits">{report.remaining.map((item, index) => <li key={index}>{item}</li>)}</ul></div>
    <details className="delivery-section"><summary>Lire le diff complet retourné</summary><pre className="diff-content">{report.diff || 'Aucun diff retourné.'}</pre></details>
  </section>;
}
