import { Monitor, ShieldCheck } from 'lucide-react';
import { useApp } from '../state';
import { ConnectionPanel } from '../components/ConnectionPanel';
import { Field, SectionHeading } from '../components/ui';
export function Settings({ theme, setTheme, width, setWidth }: {
    theme: string;
    setTheme: (theme: string) => void;
    width: number;
    setWidth: (width: number) => void;
}) {
    const { bootstrap, connected } = useApp();
    return <div className="page-scroll management-page"><SectionHeading index="11" title="Connexion & paramètres" detail="L’interface et le moteur sont distincts. Configurez votre espace, vérifiez la frontière locale."/>
    <div className="split-management"><ConnectionPanel /><section className="form-panel"><div className="panel-title"><Monitor size={17}/><h3>Votre espace de travail</h3><span className="badge">{window.cortexDesktop ? 'DESKTOP' : 'WEB'}</span></div><Field label="Thème"><select value={theme} onChange={e => setTheme(e.target.value)}><option value="dark">Graphite & cuivre</option><option value="light">Ivoire & cuivre</option></select></Field><Field label={`Largeur du panneau agent · ${width} px`} hint="La disposition mobile utilise des panneaux superposés, pas un éditeur compressé."><input type="range" min={290} max={480} value={width} onChange={e => setWidth(Number(e.target.value))}/></Field><p className="small">L’explorateur et le tiroir sont redimensionnables sur Desktop. Préférences dans la session de l’interface, sans stockage de secrets.</p><h4>Capacités déclarées du connecteur</h4>{connected ? <div className="capability-list">{Object.entries(bootstrap?.capabilities || {}).map(([key, supported]) => <div key={key}><code>{key}</code><span className="badge">{supported ? 'Déclarée disponible' : 'Non prise en charge'}</span></div>)}</div> : <p className="small">Non connues tant que le connecteur n’est pas associé.</p>}</section></div>
    <section className="security-section"><div className="panel-title"><ShieldCheck size={18}/><h3>La confiance n’est pas une case implicite.</h3></div><div className="security-columns"><div><h4>Clés & pairing</h4><p>Jeton en mémoire, fragment retiré de l’URL de cette page. Clés envoyées uniquement au loopback explicitement choisi. Le modèle utilise ensuite son fournisseur ; votre code peut donc lui être transmis avec votre accord.</p></div><div><h4>Permissions ≠ sandbox</h4><p>Ask et Plan ne doivent pas modifier ni exécuter. Agent demande les autorisations sensibles. Une commande approuvée s’exécute avec les droits de votre utilisateur et peut accéder à son environnement. Le coffre ne protège pas un appareil compromis.</p></div><div><h4>Preview hébergée</h4><p>Pas de moteur cloud, pas de proxy secret, pas d’accès automatique aux fichiers. Réseau privé/HTTPS/CORS peuvent empêcher le pairing : ouvrez alors le lien Web local du connecteur ou utilisez Desktop.</p></div></div></section>
  </div>;
}
