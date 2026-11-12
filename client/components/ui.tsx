import { RefreshCw, AlertCircle, ChevronRight, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { useApp } from '../state';
import { PRODUCT_NAME } from '../config';
export function Brand({ compact = false }: {
    compact?: boolean;
}) {
    return <div className="brand"><img src="logo.svg" width="32" height="32" alt=""/>{!compact && <div><strong>{PRODUCT_NAME.replace(/\s+Coder$/i, '').toUpperCase()}</strong><span>CODER / LOCAL FIRST</span></div>}</div>;
}
export function SectionHeading({ index, title, detail, action }: {
    index: string;
    title: string;
    detail: string;
    action?: ReactNode;
}) {
    return <header className="section-heading"><div><span className="eyebrow">{index} / ATELIER LOCAL</span><h1>{title}</h1><p>{detail}</p></div>{action}</header>;
}
export function Empty({ title, detail, children }: {
    title: string;
    detail: string;
    children?: ReactNode;
}) {
    return <div className="empty-state"><div className="empty-symbol"><ChevronRight size={24}/><ChevronRight size={24}/></div><h3>{title}</h3><p>{detail}</p>{children}</div>;
}
export function ErrorBox({ error, retry }: {
    error: string;
    retry?: () => void;
}) {
    if (!error)
        return null;
    return <div className="error-box" role="alert"><AlertCircle size={16}/><span>{error}</span>{retry && <button className="icon-button" title="Réessayer" aria-label="Réessayer" onClick={retry}><RefreshCw size={15}/></button>}</div>;
}
export function Loading() { return <div className="loading"><LoaderCircle className="spin" size={16}/> Lecture du connecteur…</div>; }
export function ProjectGate({ children }: {
    children: ReactNode;
}) {
    const { connected, project, setView } = useApp();
    if (!connected)
        return <Empty title="Un moteur local est nécessaire" detail="Cette vue utilise vos données réelles. Associez votre connecteur pour continuer."><button className="primary" onClick={() => setView('settings')}>Associer le connecteur</button></Empty>;
    if (!project)
        return <Empty title="Choisissez un projet" detail="Ouvrez un dossier réel pour accéder à ses fichiers, sa mémoire et ses outils."><button className="primary" onClick={() => setView('projects')}>Ouvrir un projet</button></Empty>;
    return <>{children}</>;
}
export function JsonResult({ value }: {
    value: unknown;
}) {
    return <pre className="result-json">{JSON.stringify(value, null, 2)}</pre>;
}
export function Field({ label, children, hint }: {
    label: string;
    children: ReactNode;
    hint?: string;
}) {
    return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
