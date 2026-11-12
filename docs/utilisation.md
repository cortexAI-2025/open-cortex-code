# Utilisation de la version locale

## Ouvrir l'atelier

Installer la version correspondant à votre système, ou compiler les sources puis lancer `pnpm start`. Ouvrir le lien local d'association imprimé par le connecteur. Desktop réalise l'association avec son propre connecteur. Une page Web déconnectée ne peut ni modifier votre ordinateur ni tester votre fournisseur.

### Interface statique HTTPS (option expérimentale)

Le mode recommandé reste le Web servi localement ou Desktop. Une interface statique peut demander l'accès direct à un connecteur **sur le même appareil que le navigateur**, à `http://127.0.0.1:4000`; elle ne se connecte ni à l'ordinateur où elle est hébergée ni à un proxy distant. Le code de l'application `dist/` doit être servi par une origine HTTPS contrôlée par vous, et sa politique CSP doit autoriser ce loopback dans `connect-src`. L'hébergement et son activation sont facultatifs et ne sont pas requis pour utiliser le mode local.

Les demandes HTTPS sont fermées par défaut. Dans l'interface locale ou Desktop, allez à Paramètres > Connexion, confirmez « Autoriser 5 min », puis revenez sur l'interface HTTPS et relancez la demande. L'ouverture expire automatiquement; le site distant ne peut pas l'activer. Confirmez la confiance dans l'origine HTTPS exacte et demandez l'approbation. Le navigateur peut afficher un prompt Local Network Access : accordez-le uniquement si vous faites confiance à la page. Revenez à l'interface locale, comparez le domaine complet et approuvez ou refusez. Le jeton distant est lié à cette origine, en mémoire de l'onglet, et expire au bout de 30 minutes; Déconnecter le révoque. Aucun cookie n'est envoyé. Les formulaires de secrets BYOK/MCP/API sont indisponibles à distance; gérez ces clés uniquement dans le Web local/Desktop.

Une page hébergée reste en mesure de lire le code et les messages que son JavaScript affiche : n'approuvez pas un hébergeur auquel vous ne pouvez pas confier ces données. Le test HTTP automatisé n'a pas validé le prompt navigateur. Si l'accès est refusé ou bloqué, n'utilisez aucun flag, certificat auto-signé ni tunnel; utilisez le Web local ou Desktop. Compatibilité documentée dans [`pairing-https-loopback.md`](pairing-https-loopback.md).

Créer un profil fournisseur, choisir son modèle et renseigner votre propre clé lorsque le fournisseur l'exige. Pour Ollama local, aucune clé n'est nécessaire si le serveur est sans authentification. Les informations du catalogue indiquent les capacités déclarées; seul un test réel permet de confirmer l'accès pour votre compte. Ne sélectionner comme gratuit qu'un modèle dont le fournisseur confirme actuellement les conditions.

Ouvrir un projet par son chemin local, ou utiliser le sélecteur Desktop. Un projet doit être explicitement de confiance pour permettre l'exécution du moteur et des commandes. Ne pas approuver un dépôt inconnu uniquement pour dépasser ce blocage : un runner isolé est nécessaire pour du code non fiable.

## Sessions Ask, Plan et Agent

Ask répond aux questions avec les outils de lecture autorisés. Plan prépare une proposition technique sans modification. Agent utilise les outils de programmation, soumis à leurs permissions. Examiner les demandes de commande ou de modification et autoriser une fois ou refuser; une validation de plan n'autorise pas automatiquement toute commande future.

Les messages et actions affichés viennent de la session réelle. Une erreur fournisseur, un outil refusé ou un test en échec ne sont pas remplacés par un succès visuel. Pour interrompre un agent, utiliser l'interruption de session; reprendre ensuite avec les fichiers et la mémoire conservés.

Changer de modèle réutilise la session. Si le fournisseur change, l'application doit demander explicitement l'accord avant de transmettre le contexte au nouveau fournisseur. Les décisions et instructions en mémoire projet restent indépendantes du modèle. Ne pas confondre un changement d'identifiant accepté avec un appel effectivement réussi.

## Éditer, vérifier et livrer

Ouvrir les fichiers dans Monaco, effectuer une modification puis sauvegarder. Le connecteur vérifie le hash courant : un conflit doit être examiné, pas écrasé silencieusement. Les résultats Git servent à revoir les différences avant intégration.

La console de commandes est un exécuteur borné, pas une session PTY complète. Une commande explicitement marquée comme test est enregistrée avec sa sortie et son code de retour; la livraison ne présente pas une commande ordinaire comme test. Une analyse IA de logs n'est qu'un diagnostic probable tant qu'une correction et des tests n'en confirment pas l'effet.

Créer un checkpoint avant les changements importants. La restauration exige l'examen des versions courantes puis confirmation; elle ne remplace pas une sauvegarde indépendante. Aucun push, merge ou changement de branche protégée n'est automatique.

## Mémoire, Knowledge et Skills

La mémoire de chaque projet conserve décisions, instructions, tâches, erreurs et notes. Corriger une information obsolète avant une nouvelle tâche. Importer des documents texte/Markdown dans Knowledge et rechercher les passages utiles; les formats binaires ne sont pas automatiquement compris si leur extraction n'est pas implémentée.

Créer ou éditer les Skills locaux puis exporter après examen vers le format OpenCode. La génération de Skill crée une véritable tâche modèle, si un profil fonctionne; le contenu produit doit encore être relu et validé. Aucun Skill ne doit accroître implicitement les permissions d'un agent.

## MCP, API et automatismes

Configurer un serveur MCP local ou distant, examiner sa commande/URL puis tester la connexion. « Configuré » n'est pas « connecté », et « connecté » n'est pas une autorisation générale d'utiliser tous ses outils. Les opérations sensibles restent soumises à permission.

Les APIs REST séparent headers publics et secrets locaux. Les tests de première version utilisent des méthodes de lecture; la présence d'une configuration n'atteste pas une compatibilité universelle de l'API. GitHub exige une authentification locale `gh` réelle.

Une automatisation locale ne s'exécute que lorsque le connecteur est actif et le profil disponible. Les exécutions non supervisées sont limitées à Ask. Les événements GitHub/CI non disponibles ou non connectés doivent rester signalés comme limites. Les agents parallèles travaillent dans des worktrees distincts; examiner leurs diffs avant toute intégration manuelle.
