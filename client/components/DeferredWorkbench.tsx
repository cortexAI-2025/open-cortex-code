import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType } from 'react';

export interface WorkbenchProps {
  theme: string;
}

export type WorkbenchModule = { default: ComponentType<WorkbenchProps> };
export type WorkbenchLoader = () => Promise<WorkbenchModule>;

const importWorkbench: WorkbenchLoader = async () => {
  await import('../monaco');
  const { Workbench } = await import('./Workbench');
  return { default: Workbench };
};

function ImportFailure({ onRetry }: { onRetry: () => void }) {
  return <div className="loading editor-lazy-error" role="alert" aria-live="assertive">
    <span>Impossible de charger l’éditeur. Réessayez; aucun fichier n’a été ouvert par cet échec.</span>
    <button className="secondary" type="button" aria-label="Réessayer le chargement de l’éditeur" onClick={onRetry}>Réessayer</button>
  </div>;
}

export function DeferredWorkbench({
  active,
  theme,
  loadWorkbench = importWorkbench,
}: {
  active: boolean;
  theme: string;
  loadWorkbench?: WorkbenchLoader;
}) {
  const [mounted, setMounted] = useState(active);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (active) setMounted(true);
  }, [active]);

  const retry = () => setAttempt(current => current + 1);
  const LazyWorkbench = useMemo(() => lazy(async () => {
    try {
      return await loadWorkbench();
    } catch {
      return { default: () => <ImportFailure onRetry={retry}/> };
    }
  }), [attempt, loadWorkbench]);

  if (!mounted) return null;

  return <div className="persistent-editor" hidden={!active}>
    <Suspense fallback={<div className="loading editor-lazy-loading" role="status" aria-live="polite">Chargement de l’éditeur…</div>}>
      <LazyWorkbench theme={theme}/>
    </Suspense>
  </div>;
}
