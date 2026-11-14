# Réalisation — critères complets

Statuts ouverts tant que le comportement et sa preuve ne sont pas établis. La portée initiale reste intégrale.

> **Bilan au 12 novembre 2026 : réalisation partielle, périmètre source intégral conservé.** Le noyau local a été éprouvé avec OpenCode 2.2.7 et un modèle Ollama; les 86 tests du dépôt passent. Cela ne valide pas les API commerciales, les événements GitHub, les intégrations MCP distantes, le sandbox OS ni l'ensemble des livrables multi-plateformes. Voir [`docs/rapport-tests.md`](docs/rapport-tests.md) pour les preuves et les limites exactes. Les critères ci-dessous restent ouverts tant que chaque clause n'est pas livrée.

## [ ] 1. MISSION

Tu es Manus Pro. Agis comme une équipe complète d'architectes logiciels, développeurs full-stack, ingénieurs IA, spécialistes DevOps, UX/UI et sécurité.

Ta mission est de concevoir, développer, tester et livrer une véritable application de programmation agentique, comparable fonctionnellement à OpenAI Codex, Claude Code et Google Jules.

Moteur principal : OpenCode

Dépôt officiel : https://github.com/anomalyco/opencode

Ne crée pas un simple chatbot ou un éditeur de texte avec IA. Construis un véritable agent de programmation capable de travailler sur des projets logiciels complets.

L'objectif est de réunir :

- La puissance fonctionnelle de Codex.
- Le fonctionnement agentique de Claude Code.
- La flexibilité open source d'OpenCode.
- La liberté de choisir son modèle IA.
- Un système BYOK (Bring Your Own Key).
- Des connexions MCP et API externes.
- Une mémoire persistante par projet.
- Des Skills et des automatisations programmées.

Le nom définitif du produit sera choisi ultérieurement. Utilise un nom provisoire configurable.

## [ ] 2. ARCHITECTURE GÉNÉRALE

Construis une application Web et une application Desktop partageant une architecture commune.

L'application doit être modulaire, évolutive, sécurisée et maintenable.

Réutilise OpenCode comme moteur principal plutôt que de recréer ses capacités existantes.

Vérifie sa licence, ses possibilités d'intégration, son SDK, ses API et ses mécanismes d'extension avant de choisir l'architecture définitive.

Privilégie :

- TypeScript.
- React et Next.js pour l'interface Web, si adaptés.
- Monaco Editor pour l'édition du code.
- Tauri ou Electron pour le Desktop, selon les contraintes réelles d'OpenCode.
- Une base de données pour les projets et métadonnées non sensibles.
- Une architecture compatible avec l'hébergement proposé par Manus.

Ne choisis pas une technologie uniquement par habitude. Justifie les décisions importantes.

## [ ] 3. MULTI-LLM UNIVERSEL

L'utilisateur doit pouvoir sélectionner librement son fournisseur IA et son modèle.

Prévoir notamment :

- Z.ai : GLM-4.5 Flash et GLM-4.7 Flash.
- Google Gemini.
- OpenAI.
- Anthropic Claude.
- Mistral.
- DeepSeek.
- Qwen.
- Groq.
- OpenRouter.
- Hugging Face.
- Ollama pour les modèles locaux.
- Fournisseurs compatibles OpenAI API.
- Fournisseurs personnalisés.

Les noms des modèles sont des exemples. Vérifie leur disponibilité effective, leurs identifiants API et leur compatibilité avec les appels d'outils.

Modèle initial privilégié : GLM-4.5 Flash.

L'utilisateur choisit son fournisseur, sélectionne son modèle et renseigne sa propre clé API.

Il doit pouvoir enregistrer plusieurs configurations et changer de modèle sans perdre le contexte de son projet.

Afficher, lorsque disponibles :

- Fenêtre de contexte.
- Compatibilité avec les outils.
- Capacités de raisonnement.
- Consommation de tokens.
- Coût estimé.
- Disponibilité des modèles.

Ne jamais présenter un modèle comme gratuit sans vérification.

## [ ] 4. SÉCURITÉ DES CLÉS API — EXIGENCE ABSOLUE

Les clés API appartiennent exclusivement aux utilisateurs.

Elles ne doivent jamais être intégrées :

- Au dépôt GitHub.
- Au code source.
- À la base de données de l'éditeur.
- Aux journaux applicatifs.
- Aux systèmes de télémétrie.
- Aux fichiers publics de configuration.

Sur Desktop, utiliser un stockage local sécurisé, idéalement le coffre de secrets du système d'exploitation.

Sur Web, privilégier les mécanismes permettant de conserver les clés sur l'appareil utilisateur.

Ne jamais promettre qu'une clé reste exclusivement locale lorsqu'une requête nécessite sa transmission à un serveur intermédiaire.

Si un fournisseur ne permet pas les appels directs sécurisés depuis le navigateur, proposer une architecture locale ou un connecteur explicitement autorisé, sans stockage permanent sur l'infrastructure de l'éditeur.

Prévoir la suppression, la rotation et le masquage des clés.

## [ ] 5. MOTEUR DE PROGRAMMATION AGENTIQUE

Implémenter trois modes principaux.

Mode Ask

L'agent analyse le projet et répond aux questions sans modifier les fichiers.

Mode Plan

L'agent étudie la demande, identifie les fichiers concernés, prépare un plan technique et présente les étapes avant exécution.

Mode Agent

L'agent peut, dans les limites de ses permissions :

- Explorer les dépôts.
- Lire et modifier les fichiers.
- Créer des fonctionnalités.
- Corriger les bugs.
- Installer des dépendances.
- Exécuter des commandes.
- Lancer les tests.
- Analyser les résultats.
- Corriger les erreurs.
- Préparer des commits et pull requests.

Afficher clairement le plan, les actions effectuées et les résultats.

## [ ] 6. ENVIRONNEMENT DE DÉVELOPPEMENT

Créer une interface professionnelle comprenant :

- Explorateur de fichiers.
- Éditeur avec coloration syntaxique.
- Onglets de fichiers.
- Terminal intégré.
- Console de logs.
- Panneau de conversation IA.
- Affichage des différences Git.
- Historique des modifications.
- Prévisualisation Web.
- Panneau des tests.
- Gestionnaire de projets.

Prévoir une disposition personnalisable et des thèmes clair et sombre.

L'interface doit être originale, moderne, rapide et adaptée à un usage intensif.

## [ ] 7. GIT ET GITHUB

Intégrer une gestion Git complète :

- Connexion GitHub.
- Import et clonage des dépôts.
- Création de branches.
- Lecture des commits.
- Visualisation des différences.
- Création de commits.
- Pull requests.
- Revue des modifications.
- Résolution assistée des conflits.
- Consultation des workflows GitHub Actions.
- Analyse des échecs CI.

Ne jamais fusionner une pull request ou modifier une branche protégée sans autorisation explicite.

## [ ] 8. AGENTS PARALLÈLES

Permettre plusieurs tâches de programmation en parallèle.

Utiliser des environnements isolés, notamment Git Worktrees lorsque c'est adapté.

Chaque agent doit posséder :

- Sa tâche.
- Son contexte.
- Sa branche ou son espace isolé.
- Son historique.
- Ses résultats.

Prévoir une interface de supervision des agents et une procédure contrôlée d'intégration des modifications.

## [ ] 9. MÉMOIRE PERSISTANTE PAR PROJET

Chaque projet doit disposer d'une mémoire indépendante.

Conserver :

- Architecture logicielle.
- Technologies utilisées.
- Dépôts associés.
- Décisions techniques.
- Instructions spécifiques.
- Sessions précédentes.
- Tâches réalisées.
- Tâches en attente.
- Erreurs connues.
- Résumés des modifications.
- Documentation importante.

L'utilisateur doit pouvoir interrompre une session, fermer l'application et reprendre ultérieurement sans repartir de zéro.

Le changement de LLM ne doit pas supprimer la mémoire du projet.

Prévoir un système de recherche et de récupération du contexte pertinent pour éviter de transmettre inutilement l'intégralité des conversations et du dépôt à chaque appel.

Les mémoires doivent être actualisées après les changements significatifs.

## [ ] 10. KNOWLEDGE BASE

Créer une base de connaissances par projet.

Permettre l'import de documents techniques, spécifications, fichiers Markdown, documentation API et autres ressources utiles.

Indexer les documents et retrouver uniquement les passages nécessaires à la tâche.

Permettre à l'utilisateur de corriger, supprimer ou réinitialiser les connaissances enregistrées.

## [ ] 11. MCP — MODEL CONTEXT PROTOCOL

Créer un gestionnaire universel de connexions MCP.

Prévoir des intégrations avec :

- GitHub.
- Supabase.
- Vercel.
- Render.
- Stripe.
- Gmail.
- Notion.
- Google Drive.
- Google Calendar.
- Autres services compatibles.

Permettre l'ajout manuel de serveurs MCP personnalisés.

Prendre en charge les transports compatibles avec les spécifications MCP retenues, notamment les connexions locales et distantes lorsque l'environnement d'exécution le permet.

Prévoir :

- Découverte des outils.
- Configuration des connexions.
- Authentification.
- Permissions individuelles.
- Activation et désactivation.
- Tests de connexion.
- Historique des appels.
- Gestion des erreurs.

Les opérations sensibles doivent nécessiter une validation explicite.

## [ ] 12. API EXTERNES

En complément des MCP, permettre la connexion à des API REST et autres interfaces compatibles.

L'utilisateur doit pouvoir configurer :

- URL de base.
- Méthode d'authentification.
- En-têtes autorisés.
- Endpoints.
- Paramètres.
- Permissions.

Prévoir des tests de connexion et une documentation des outils disponibles.

Les identifiants doivent respecter les mêmes règles de sécurité que les clés des fournisseurs IA.

## [ ] 13. SKILLS PERSONNALISÉS

Créer une bibliothèque de Skills réutilisables.

Exemples :

- Développement Android Kotlin.
- Développement React.
- Next.js.
- Supabase.
- Audit de sécurité.
- Revue de code.
- Tests automatisés.
- Publication Android.
- Optimisation des performances.
- Documentation technique.

Créer un éditeur permettant à l'utilisateur de définir ses propres Skills.

Ajouter un générateur de Skills en langage naturel.

Permettre d'associer des Skills à un projet ou à une tâche.

## [ ] 14. AUTOMATISATIONS PROGRAMMÉES

Créer un planificateur permettant de lancer des tâches automatiquement.

Déclencheurs :

- Heure définie.
- Récurrence quotidienne ou hebdomadaire.
- Événement GitHub.
- Échec de compilation.
- Nouvelle pull request.
- Déclenchement manuel.

Exemples :

- Vérification quotidienne des workflows.
- Analyse des dépendances.
- Revue de code automatique.
- Génération de rapports.
- Diagnostic des builds.
- Mise à jour de documentation.

Les automatisations utilisant des clés exclusivement locales doivent fonctionner dans un environnement local autorisé et disponible.

Prévoir un historique des exécutions, des notifications et des règles de validation.

## [ ] 15. PRÉVISUALISATION WEB

Permettre de lancer et visualiser les applications Web développées.

Prévoir :

- Aperçu Desktop.
- Aperçu Mobile.
- Rechargement après modification.
- Consultation des erreurs.
- Inspection des logs.
- Tests visuels lorsque techniquement disponibles.

Ne jamais exécuter du code non fiable directement dans l'environnement principal de l'application.

## [ ] 16. REVUE DE CODE ET SÉCURITÉ

Intégrer un système de revue de code capable de :

- Détecter des bugs probables.
- Identifier des régressions.
- Repérer des problèmes de sécurité.
- Vérifier les conventions du projet.
- Proposer des améliorations.
- Analyser les modifications Git.

Présenter les observations avec leur niveau de gravité et les fichiers concernés.

Distinguer les problèmes confirmés des hypothèses.

## [ ] 17. POINTS DE RESTAURATION

Créer des points de restauration avant les modifications importantes.

Permettre :

- Visualisation des changements.
- Annulation d'une modification.
- Restauration d'un état précédent.
- Comparaison des versions.
- Confirmation avant suppression ou écrasement.

Utiliser Git et des mécanismes complémentaires lorsque nécessaire.

## [ ] 18. DIAGNOSTIC AUTOMATIQUE

Lorsqu'un test, un build ou un déploiement échoue :

1. Récupérer les logs.
2. Identifier les causes probables.
3. Présenter un diagnostic.
4. Proposer une correction.
5. Appliquer la correction après autorisation si nécessaire.
6. Relancer les tests.
7. Présenter le résultat.

Prévoir notamment les projets Android, Node.js, Python et Web.

## [ ] 19. MODE ÉCONOMIE INTELLIGENTE

Optimiser l'utilisation des modèles IA.

Fonctionnalités :

- Sélection des fichiers pertinents.
- Résumés de contexte.
- Réutilisation des analyses valides.
- Limitation des appels redondants.
- Estimation des tokens.
- Affichage de la consommation.
- Sélection manuelle du modèle.
- Possibilité de proposer un modèle alternatif compatible.

Ne jamais changer silencieusement de fournisseur ou envoyer du code à un nouveau fournisseur sans accord de l'utilisateur.

## [ ] 20. CHANGEMENT DE MODÈLE SANS PERTE DE CONTEXTE

Permettre de changer de modèle pendant un projet ou entre deux étapes d'une tâche.

Préserver :

- Plan de travail.
- État des fichiers.
- Historique utile.
- Décisions techniques.
- Résultats des tests.
- Tâches restantes.

Préparer un résumé de transfert structuré pour le nouveau modèle.

## [ ] 21. MODE LIVRAISON PROFESSIONNELLE

À la fin d'une tâche, générer :

- Résumé des modifications.
- Liste des fichiers modifiés.
- Résultats des tests.
- Problèmes restants.
- Documentation actualisée.
- Proposition de commit.
- Pull request si autorisée.

Selon le projet, permettre la production d'artefacts tels que APK, AAB, ZIP ou builds Web.

Ne jamais déclarer une compilation réussie sans résultat réel.

## [ ] 22. DESIGN UX/UI

Créer une interface originale et professionnelle, inspirée des meilleures pratiques des environnements de développement modernes, sans copier leur identité visuelle.

Navigation principale :

- Tableau de bord.
- Projets.
- Sessions.
- Éditeur.
- Agents.
- Modèles IA.
- MCP et API.
- Skills.
- Automatisations.
- Mémoire et Knowledge.
- Historique.
- Paramètres.

Prévoir un onboarding simple :

1. Choix du fournisseur IA.
2. Sélection du modèle.
3. Configuration sécurisée de la clé API.
4. Test de connexion.
5. Création ou import d'un projet.
6. Première tâche de programmation.

## [ ] 23. INFRASTRUCTURE ET HÉBERGEMENT

Utiliser les capacités d'hébergement et de base de données disponibles dans Manus lorsque cela est techniquement adapté.

Ne pas supposer que cet hébergement permet nativement les terminaux persistants, les conteneurs privilégiés ou l'exécution arbitraire de code.

Distinguer clairement :

- Interface Web.
- Backend applicatif.
- Moteur OpenCode.
- Environnements d'exécution isolés.
- Stockage local des secrets.
- Mémoire des projets.
- Automatisations.

L'application Desktop doit pouvoir utiliser les ressources locales de l'utilisateur.

Pour la version Web, proposer un mécanisme d'exécution compatible avec les contraintes de sécurité et d'hébergement.

## [ ] 24. TESTS ET VALIDATION

Créer des tests automatisés couvrant :

- Configuration des fournisseurs.
- Connexion aux modèles.
- Gestion sécurisée des secrets.
- Création de projets.
- Persistance des sessions.
- Modification de fichiers.
- Exécution des tests.
- Git.
- MCP.
- Skills.
- Automatisations.
- Points de restauration.
- Changement de modèle.
- Prévisualisation.

Tester réellement les fonctionnalités réalisables dans l'environnement Manus.

Ne jamais utiliser des résultats fictifs pour présenter une fonctionnalité comme opérationnelle.

Documenter les limitations et les tests nécessitant des identifiants ou des environnements externes.

## [ ] 25. LIVRABLES OBLIGATOIRES

Livrer :

1. Code source complet.
2. Application Web fonctionnelle.
3. Application Desktop ou chaîne de compilation vérifiée.
4. Architecture documentée.
5. Configuration des fournisseurs LLM.
6. Gestionnaire MCP et API.
7. Gestion des projets et mémoire.
8. Skills et automatisations.
9. Tests automatisés.
10. Documentation d'installation.
11. Documentation utilisateur.
12. Instructions de déploiement.
13. Exemple de configuration sans secrets.
14. Rapport de sécurité.
15. Rapport de tests.
16. Liste précise des fonctionnalités terminées, partielles et non réalisées.

Préparer le projet pour une publication ultérieure sur GitHub.

## [ ] 26. MÉTHODE DE TRAVAIL

Travaille de manière autonome et structurée.

Commence par examiner le dépôt OpenCode, sa licence, sa documentation et ses capacités existantes.

Identifie ce qui peut être réutilisé directement et ce qui doit être développé.

Construis ensuite une architecture cohérente, puis réalise l'implémentation par modules.

Priorise le moteur de programmation réellement fonctionnel, le multi-LLM, le BYOK sécurisé et la gestion des projets avant les fonctionnalités secondaires.

Ne te limite pas à une maquette ou à une démonstration visuelle.

Évite les simulations, les boutons sans action et les intégrations factices.

Si certaines fonctionnalités ne peuvent pas être achevées dans l'environnement ou les ressources disponibles, livre un noyau opérationnel, explique précisément les limitations et fournis les étapes restantes.

Ne prétends jamais avoir terminé une fonctionnalité non testée.

## [ ] 27. RÉSULTAT ATTENDU

Je veux une véritable application de développement IA.

Elle doit permettre à un utilisateur de :

1. Installer ou ouvrir l'application.
2. Choisir son fournisseur et son modèle IA.
3. Configurer sa propre clé API.
4. Connecter GitHub et ses outils MCP.
5. Ouvrir un projet logiciel.
6. Demander une fonctionnalité ou une correction.
7. Laisser l'agent analyser, planifier et modifier le code.
8. Exécuter les tests.
9. Examiner les résultats.
10. Préparer une livraison.
11. Fermer puis reprendre son projet ultérieurement sans perdre sa mémoire.

Vision finale : la puissance fonctionnelle des meilleurs agents de programmation, construite sur OpenCode, avec une architecture ouverte, multi-LLM, BYOK, MCP, Skills, automatisations et mémoire persistante.

Construis le produit le plus complet et le plus fiable possible, sans sacrifier la sécurité ni la réalité fonctionnelle.

Commence maintenant par l'analyse technique d'OpenCode, puis poursuis la réalisation de manière autonome jusqu'aux livrables vérifiables.

## [ ] Priorités validées le 11 novembre 2026

Tester OpenCode 2.2.7 avec de véritables sessions agentiques. Exploration de code, modifications multi-fichiers, exécution de tests, diagnostic, correction itérative, revue de diff et travail parallèle. Changement de fournisseur/modèle sans perte du contexte. Mémoire indépendante par projet. MCP/GitHub/Skills/automatisations à permissions strictes. Desktop installable et Web local. Aucun test ni intégration simulés. Aucune dépense, opération destructive ou publication/déploiement production sans autorisation.

## [ ] 28. CONNEXION SÉCURISÉE D'UNE UI HTTPS HÉBERGÉE AU CONNECTEUR LOCAL

Préserver strictement l'architecture locale et BYOK.

Développer et tester la connexion sécurisée entre l'interface HTTPS hébergée et le connecteur local, sous les conditions suivantes :

1. Le serveur Open Cortex reste exclusivement sur l'appareil de l'utilisateur, lié à `127.0.0.1`.
2. Les clés API BYOK restent locales et ne sont jamais transmises à Manus ni à un backend cloud.
3. Mettre en place une authentification explicite entre l'interface et le connecteur local, avec autorisation de l'utilisateur.
4. Protéger les communications contre les accès non autorisés, le CSRF, le DNS rebinding et les origines non approuvées.
5. Étudier les contraintes HTTPS, CORS, Private Network Access et Local Network Access des navigateurs avant de retenir une solution. Ne pas considérer CORS comme un mécanisme d'authentification.
6. Ne pas désactiver les protections du navigateur ni utiliser de contournement TLS.
7. Ne pas ajouter de configuration `deploy` destinée à publier le serveur local.
8. Ne pas exposer le connecteur sur Internet ni ouvrir de tunnel public.
9. Ne pas modifier la frontière de sécurité existante.
10. Réaliser les tests locaux et documenter les limites de compatibilité navigateur.

Si une connexion directe sécurisée n'est pas réalisable dans certains navigateurs, documenter le blocage et proposer une architecture alternative locale sans l'implémenter automatiquement.

Livrables attendus : code local, tests de sécurité, documentation d'installation, matrice de compatibilité et rapport technique.

Aucune publication Manus, aucun déploiement cloud et aucune mise en production sans autorisation explicite. Critères ouverts jusqu'à preuve de chaque résultat réel.

**État partiel (12 novembre 2026)** : connecteur local `127.0.0.1`, demandes distantes fermées par défaut et fenêtre de cinq minutes activée seulement localement, pairing à origine HTTPS exacte, approbation/refus local, token temporaire révocable, préflight CORS/PNA strict, refus Host/Origin hostile, protection des secrets et plafonds de fréquence/capacité sont implémentés. Tests de contrat Node/HTTP réussis. Parcours E2E réel HTTPS→loopback réussi sous Chromium 156.0.8078.73 et Firefox 160.0 sur Ubuntu 24.04.5 ARM64 : prompt LNA affiché/accepté, approbation locale, association UI et révocation/déconnexion réussies; permissions de profils temporaires non mémorisées. Statuts détaillés `OPTIONS 204`, `POST 202`, `GET 200`, `GET /api/bootstrap 200` observés sous Chromium seulement. Limites encore ouvertes : refus LNA, autres versions/OS, Safari, Android/WebView, CSP/Permissions-Policy d'autres hébergeurs et tests multi-appareils. L'interface statique est publiée séparément sur GitHub Pages avec autorisation; le connecteur reste local et aucun déploiement backend Manus n'a été effectué. Critères de compatibilité généraux ouverts jusqu'à élargissement des preuves.

## [x] 29. OPTIMISATION DU CHARGEMENT MONACO — 13 NOVEMBRE 2026

Objectif : réduire significativement le JavaScript chargé au démarrage, sans supprimer ni dégrader les fonctionnalités de Monaco Editor.

### Phase 1 — Lazy loading

- Examiner les imports actuels de Monaco et Workbench.
- Implémenter `React.lazy()` et `Suspense`.
- Monter Workbench uniquement lorsque l'éditeur est ouvert.
- Vérifier qu'aucun import statique indirect ne réintègre Monaco dans le bundle initial.
- Prévoir un indicateur de chargement léger.
- Préserver l'état de l'éditeur lors des changements de vue lorsque nécessaire.

### Phase 2 — Workers

- Auditer la configuration des workers Monaco.
- Charger uniquement les workers nécessaires aux langages utilisés, lorsque l'architecture le permet.
- Préserver TypeScript, JavaScript, CSS, HTML et JSON.
- Vérifier les diagnostics et l'autocomplétion après optimisation.

### Phase 3 — Mesures

Exécuter :

- `pnpm analyze:bundle`
- `pnpm build`
- `pnpm typecheck`
- `pnpm test`

Comparer avant/après :

- Taille du bundle d'entrée, brut et gzip.
- Taille totale des fichiers JavaScript émis.
- Nombre et taille des chunks.
- Chargement initial réel.
- Chargement lors de la première ouverture de Monaco.
- Absence de régression fonctionnelle.

Ne pas présenter une réduction du bundle initial comme une réduction équivalente du téléchargement total.

### Phase 4 — Livraison

- Préparer les modifications sur une branche dédiée.
- Fournir les résultats mesurés avant/après.
- Vérifier les tests.
- Ne pas fusionner ni déployer sans validation.

Ne pas remplacer Monaco, React DOM ou Lucide à cette étape.


### Finalisation demandée le 13 novembre 2026

Avant tout commit :

1. Vérifier précisément les changements de la branche et séparer les modifications Monaco des travaux antérieurs de pairing.
2. Vérifier qu'aucun état de l'éditeur n'est perdu lors des changements de vue.
3. Ajouter un test automatisé reproductible du chargement différé de Monaco, sans dépendre d'une fixture temporaire.
4. Vérifier le comportement en cas d'échec du chargement dynamique et prévoir une interface de reprise.
5. Contrôler les performances de première ouverture de l'éditeur et les éventuelles requêtes réseau supplémentaires.
6. Conserver Monaco, React DOM, Lucide et les workers existants.
7. Relancer build, typecheck et les 86 tests existants, ainsi que les nouveaux tests.

Ensuite, préparer un commit local limité à cette optimisation et fournir son SHA.

Ne pas pousser, fusionner ou déployer sans nouvelle validation.
