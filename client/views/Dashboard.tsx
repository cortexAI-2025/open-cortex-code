import { ArrowUpRight, FolderOpen, KeyRound, Shield, Terminal, Cable } from 'lucide-react';
import { useApp } from '../state';
import { ConnectionPanel } from '../components/ConnectionPanel';
export function Dashboard() {
    const { connected, bootstrap, project, setView } = useApp();
    return <div className="dashboard page-scroll">
    <div className="hero-top"><span className="eyebrow">OPEN SOURCE · LOCAL FIRST · BYOK</span><span className="edition">ATELIER / 0.1</span></div>
    <section className="hero"><div className="hero-line"/><p className="hero-kicker">LA PROGRAMMATION, SOUS VOTRE CONTRÔLE.</p><h1>Votre code.<br />Votre moteur.<br /><em>Vos règles.</em></h1><p className="hero-description">Un espace pour explorer, construire et vérifier.<br />OpenCode exécute. Vous choisissez le modèle<br className="desktop-break"/> et autorisez chaque action sensible.</p>
      <button className="text-action" onClick={() => setView(connected ? 'projects' : 'settings')}>{connected ? 'Ouvrir un projet réel' : 'Connecter mon environnement'}<ArrowUpRight size={17}/></button>
      <div className="hero-mark" aria-hidden="true"><svg viewBox="0 0 240 220"><path d="m25 20 100 90L25 200m90-180 100 90-100 90"/></svg></div>
    </section>
    <div className="onboarding-steps">
      <button onClick={() => setView('settings')}><span className="step-number">01</span><Cable size={17}/><strong>Connecteur</strong><small>{connected ? 'Associé à votre appareil' : 'Lancer & associer'}</small></button>
      <button onClick={() => setView('projects')}><span className="step-number">02</span><FolderOpen size={17}/><strong>Projet</strong><small>{project ? project.name : 'Ouvrir un dossier réel'}</small></button>
      <button onClick={() => setView('models')}><span className="step-number">03</span><KeyRound size={17}/><strong>Modèle BYOK</strong><small>Choisir & vérifier la clé</small></button>
      <button onClick={() => setView('editor')}><span className="step-number">04</span><Terminal size={17}/><strong>Première tâche</strong><small>Ask → Plan → Agent</small></button>
    </div>
    <div className="dashboard-bottom"><div className="guide-panel"><div className="panel-title"><Terminal size={17}/><h3>{connected ? 'État réel de votre atelier' : 'Démarrer sur votre appareil'}</h3><span className="badge">GUIDE LOCAL</span></div>
      {connected ? <><p>Connecteur {bootstrap?.version} · moteur déclaré {bootstrap?.engineVersion}. Ce statut ne valide pas l’accès à un modèle externe.</p><div className="facts"><span>Projets enregistrés <b>{bootstrap?.projects.length ?? 0}</b></span><span>Profils configurés <b>{bootstrap?.profiles.length ?? 0}</b></span></div><button className="secondary" onClick={() => setView('projects')}>Choisir un projet <ArrowUpRight size={14}/></button></> : <><p>Depuis les sources installées sur votre ordinateur, lancez le connecteur. Son terminal affiche le lien local et le jeton de pairing.</p><pre className="guide-code"><span># Dans le dossier Open Cortex Coder</span>{'\n'}pnpm dev:local</pre><p className="small">Pour la version compilée : <code>pnpm start</code>. Pour Desktop : <code>pnpm desktop</code> après compilation.</p><div className="trust-note"><Shield size={17}/><span>Cette interface hébergée ne peut ni lire vos dossiers ni exécuter votre code tant que votre connecteur n’est pas associé.</span></div></>}
    </div><ConnectionPanel /></div>
    <footer className="dashboard-footer"><span>UN MOTEUR OUVERT. AUCUNE CONFIANCE IMPLICITE.</span><button onClick={() => setView('settings')}>Frontières de sécurité <ArrowUpRight size={12}/></button></footer>
  </div>;
}
