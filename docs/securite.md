# Sécurité — Open Cortex Coder 0.1

Le connecteur et le moteur sont destinés à un appareil utilisateur local. La Preview hébergée est un frontend, pas un environnement d'exécution du code utilisateur. Aucun proxy cloud de clés BYOK n'est présent. Les secrets sont envoyés directement du moteur local vers le fournisseur sélectionné, pas conservés sur l'infrastructure éditeur.

## Secrets

Les clés fournisseur et les identifiants REST/API restent dans un coffre mémoire séparé des profils et des métadonnées SQLite. La réponse HTTP d'un profil contient un état de présence, pas la clé. Suppression/rotation invalidant le profil actif doivent arrêter ou renouveler l'instance du moteur qui possédait la clé : la seule suppression d'un champ d'interface ne suffit pas.

Desktop propose un chiffrement facultatif avec `Electron.safeStorage`. La persistance est refusée lorsque l'OS ne fournit pas de backend sûr, notamment le backend Linux `basic_text`. Les fichiers chiffrés locaux sont protégés par permissions du compte utilisateur. Ce mécanisme ne protège ni un appareil compromis ni un processus autorisé à accéder au même compte utilisateur. Le script de test moteur n'utilise aucune clé API; il emploie un modèle Ollama local.

Aucune valeur sensible ne doit être inscrite dans une configuration de projet ou publiée. Les erreurs et sorties collectées doivent être filtrées contre les secrets connus. Un filtre n'est pas une garantie absolue contre un encodage/exfiltration volontaire. Les sessions et les documents peuvent eux-mêmes contenir des données confidentielles : l'utilisateur doit sélectionner et contrôler ce qu'il importe et transmet.

## Connecteur et Desktop

L'interface du connecteur écoute seulement sur loopback. Les actions API requièrent un token d'association et des contrôles de Host/Origin. Le token Basic OpenCode n'est pas envoyé au renderer. Le serveur natif n'est pas exposé directement aux clients UI, car ses routes fichiers ne sont pas automatiquement restreintes par les permissions d'agent.

Desktop utilise `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, bloque les nouvelles fenêtres, les webviews et les navigations hors de son origine locale. Le pont IPC expose seulement l'association, le choix de dossier et les fonctions de coffre. Les requêtes IPC vérifient l'origine du sender. Toute prévisualisation du code développé doit rester dans un frame distinct et non privilégié; jamais comme navigation principale Electron.

Les chemins relatifs et symlinks doivent être confinés au projet sélectionné, et les fichiers de secrets/configuration sensibles doivent être refusés. L'écriture manuelle utilise un hash de contenu pour éviter d'écraser une version modifiée entre lecture et sauvegarde. Les points de restauration sont complémentaires et ne constituent pas une sauvegarde externe durable.

## Ask, Plan et Agent

Ask et Plan sont des modes non mutateurs : pas d'édition, pas de commandes arbitraires, pas de délégation pouvant accroître les droits, pas d'outils MCP implicites. Les permissions doivent rester définies par notre connecteur, pas par une configuration non auditée du dépôt. Agent soumet les actions sensibles à une décision ponctuelle. Les approbations permanentes ne sont pas automatiques.

Une demande d'autorisation n'est pas une isolation OS. Le shell, les scripts de dépendances et les outils locaux ont les droits du compte exécutant le moteur. Un dépôt approuvé peut exécuter un script malveillant; une commande de test n'est pas intrinsèquement sûre. **Les dépôts non fiables ne sont pas exécutés sans environnement isolé externe.** Les worktrees séparent branches/fichiers, pas le réseau, les processus ou les secrets.

Les opérations Git destructives, le push, le merge, les PR et les mutations de services externes doivent être explicites et autorisées. Les tests de connectivité REST utilisent des méthodes de lecture. Un GET d'un service mal conçu peut avoir des effets : utiliser uniquement des endpoints connus et autorisés. Aucun serveur externe prédéfini n'est considéré connecté par sa seule présence dans un formulaire.

## Pairing facultatif depuis une interface HTTPS

Le connecteur reste lié à `127.0.0.1`; aucun bind LAN, tunnel, proxy cloud ni certificat TLS de contournement. Les nouvelles demandes sont fermées par défaut; l'utilisateur doit ouvrir depuis l'interface locale une fenêtre de cinq minutes, puis approuver l'origine HTTPS exacte. Une page distante ne peut pas activer cette fenêtre. Le bearer est lié à cette origine, TTL court, conservé en mémoire et révocable. CORS/PNA sont des règles de permission navigateur, pas une authentification : le serveur vérifie encore Host loopback, Origin exacte et bearer sur chaque API.

Le navigateur peut demander Local Network Access et bloquer le fetch HTTP loopback depuis HTTPS selon son implémentation; ne pas désactiver sa protection. Les cookies sont omis, l'origine n'est jamais wildcard, `Origin: null` et le Host rebinding sont refusés. Les endpoints qui créent/modifient les credentials LLM/MCP/API restent réservés à l'interface locale. Cela ne protège pas les données de code lues par le JavaScript de l'origine HTTPS approuvée : une origine compromise peut exfiltrer les contenus qu'elle affiche ou tenter des actions avec le jeton autorisé. N'approuver qu'un hébergeur de confiance; préférer l'interface locale/Desktop pour un projet confidentiel. Le comportement navigateur réel n'a pas été vérifié dans cette livraison. Les contrôles et les limites sont détaillés dans [`pairing-https-loopback.md`](pairing-https-loopback.md).

## Automatisations

Les tâches utilisant des clés mémoire locales nécessitent un connecteur actif et le profil présent en mémoire. Une tâche planifiée ne doit pas auto-approuver une mutation ou un outil à effet externe en l'absence d'utilisateur. La première version locale n'est pas un service 24/7 ni un système garanti de livraison de webhooks. Les restrictions et déclencheurs non disponibles doivent être visibles.

## Conditions avant diffusion

La version 0.1 n'a pas d'audit tiers ni de certification. Valider les mises à jour de moteur sur un contrat épinglé, tester les changements d'OS/coffre/packaging, signer les binaires et mettre en place une politique de mises à jour avant distribution générale. Les builds macOS/Windows, la notarisation et la signature code ne sont pas supposés réalisés. Aucun déploiement en production n'est effectué dans cette tâche.
