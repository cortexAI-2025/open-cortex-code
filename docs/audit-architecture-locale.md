# Audit — architecture locale BYOK et distribution

**Date : 12 novembre 2026 · Auteur : Manus AI**

## Conclusion

La voie fonctionnelle et compatible avec la frontière BYOK actuelle est de servir l’interface Web et l’API depuis le connecteur local, lié exclusivement à `127.0.0.1`, ou d’utiliser l’application Desktop qui démarre ce même connecteur local. Aucun code de projet ni aucune clé n’a besoin d’être envoyé vers un serveur Manus.

Une interface statique hébergée peut désormais demander, directement depuis le navigateur, un pairing limité vers le connecteur loopback. Les nouvelles demandes restent fermées par défaut; l'utilisateur ouvre localement une fenêtre de cinq minutes, puis approuve l'origine HTTPS exacte avant qu'un jeton en mémoire ne soit délivré. Limites de cadence/capacité, préflight strict et révocation sont couverts par les tests locaux. En revanche, un parcours navigateur HTTPS réel et les permissions LNA ne sont pas testés dans cette session : la capacité est conditionnelle au navigateur/hébergeur et ne constitue pas une promesse universelle. Le JavaScript distant peut lire les données de projet qu'il affiche; utiliser seulement une origine de confiance.

Le blocage Manus est cohérent avec la configuration présente et ne doit pas être contourné par un serveur cloud. Le projet courant a `server=true` et `database=true`, un build statique vers `dist/`, mais aucune configuration `deploy`. La déclaration `server` requiert une configuration de déploiement conteneur pour la publication d’un projet serveur. Or le projet doit garder le connecteur sur l’appareil de l’utilisateur. Le contrat WebDev indique aussi que `server` et `database` sont des capacités activées à sens unique; elles ne peuvent pas être retirées de ce projet. La publication signalée a échoué à la vérification du contrat avec `publish_contract_missing`, avant tout déploiement. Aucune publication ou mise en production n’a été lancée.

## Architecture locale retenue

### Web local

`pnpm build && pnpm start` construit puis démarre le connecteur sur loopback. Le même processus sert l’interface `dist/` et les routes `/api`; l’interface et l’API sont donc de même origine et n’ont pas besoin d’un accès CORS depuis un site public. Le connecteur génère un jeton de pairing aléatoire et exige `Authorization: Bearer` pour les API autres que la santé. L’interface ne tente pas de s’associer automatiquement depuis une Preview hébergée. Le serveur refuse les binds qui ne sont pas loopback.

Les projets et l’état persistant sont enregistrés localement dans SQLite. Le stockage rejette les champs credential et dispose les répertoires/fichiers avec des permissions restrictives. Les clés fournisseurs sont injectées pour le travail local et ne sont pas écrites dans les enregistrements SQLite. Une requête de génération vers le fournisseur choisi transmet nécessairement le contexte et la clé à ce fournisseur; elle ne doit pas être confondue avec une transmission à Manus.

### Desktop

Electron démarre le connecteur lié à `127.0.0.1` puis charge l’interface depuis son origine loopback. Le renderer est isolé (`contextIsolation`, `sandbox`, `nodeIntegration: false`) et son IPC est limité à l’origine de l’application. Cette topologie garde les appels au moteur local et évite qu’une page hébergée séparément serve d’intermédiaire. Le smoke test empaqueté Linux ARM64 est consigné dans [`rapport-tests.md`](rapport-tests.md). Le coffre sécurisé OS n’était pas disponible dans l’environnement de test : ce résultat ne doit pas être présenté comme stockage durable chiffré sur toutes les plateformes.

## Diagnostic de publication et configuration Manus

Le retour fourni pour le commit `7606f9bd724756ed732972b6f5812a62577bd20e` indique : `Missing publish configuration: deploy`, code `publish_contract_missing`. Il s’agit d’un refus contractuel préalable; aucune preuve n’indique qu’un conteneur, une instance ou un déploiement ait démarré.

Le projet courant est un projet serveur car `features.server` est activé. Le contrat de publication Manus associe ce mode à `deploy` et à un Dockerfile; le champ `build` peut servir à une sortie statique dans une publication hybride, mais ne transforme pas le projet serveur en projet exclusivement statique. Ajouter `deploy` exigerait précisément de créer une cible serveur cloud, contraire à la décision BYOK locale. Ce rapport ne le fait donc pas.

`features.database` est aussi activé, mais le code applicatif utilise SQLite local et n’emploie pas la base MySQL gérée pour les projets, sessions ou clés. Ce n’est pas la cause du message `deploy` manquant. Il n’est pas prudent d’essayer de désactiver ces capacités : le contrat les déclare non désactivables après activation. Aucun changement de configuration Manus n’a été effectué; l’auto-publication demeure désactivée selon l’état précédemment inspecté.

Pour un futur site statique Manus, il faudrait un projet distinct, créé sans `server` ni `database`, puis une autorisation explicite de publication. Le client pairing est implémenté côté application, mais l'actuel projet Manus ne fournit pas cette publication et aucun test navigateur sur une telle origine hébergée n'a été effectué.

## Faisabilité d’une interface HTTPS statique connectée au loopback

Une page HTTPS peut, selon le navigateur et les permissions accordées, initier des requêtes vers un service local. Chrome a livré Local Network Access à partir de Chrome 142; le contrôle s’applique aux requêtes d’un site public vers une adresse loopback et exige un contexte sécurisé ainsi qu’une permission utilisateur. Chrome Status indique aussi l’évolution vers des permissions loopback distinctes dans les versions suivantes. Le comportement précis diffère selon les navigateurs et doit être vérifié dans leurs versions prises en charge. [1]

Le contenu mixte reste un sujet de compatibilité : `fetch()` et XHR sont des types de requêtes normalement bloqués lorsqu’une page sécurisée appelle une ressource HTTP. Les ressources loopback sont traitées spécialement par certains mécanismes, et Chrome documente une exemption liée à l’accord Local Network Access; il ne faut pas supposer une parité entre navigateurs. [1] [2]

Ce blocage protocolaire a été traité par une exception limitée au pairing : le préflight `OPTIONS` ne nécessite pas de Bearer, mais valide l'origine HTTPS exacte, la méthode et la liste d'en-têtes; la requête métier requiert ensuite un jeton temporaire lié à cette origine. Le reste des routes distantes exige ce jeton; les endpoints credentials restent réservés à l'interface locale. Le comportement navigateur réel et la permission LNA restent à vérifier sur les plateformes annoncées. [3]

Le pairing implémente les contrôles serveur décrits : origine exacte HTTPS, demandes fermées par défaut et activation locale temporaire, échange approuvé localement, jeton hashé et éphémère, limite globale de dix demandes/minute, capacité de 32 entrées, révocation, contrôle Host, préflight borné sans wildcard/cookie, et tests HTTP négatifs. La revue indépendante a identifié qu'un endpoint ouvert par défaut permettrait à une page malveillante de consommer le quota; l'activation préalable par l'interface locale atténue ce risque et est désormais couverte par les tests. Les clés sont bloquées côté serveur et leurs formulaires retirés du client distant; le jeton distant n'est ni passé en URL ni écrit en stockage durable. Le lien de pairing local d'origine peut, lui, présenter le jeton principal dans un fragment. Un risque de chaîne d'approvisionnement demeure : le JavaScript servi par l'origine distante peut lire les données de projet que l'utilisateur lui montre et tenter de les exfiltrer. La topologie recommandée pour les données confidentielles reste l'interface Web locale ou Desktop. Voir `pairing-https-loopback.md`.

## Distribution recommandée

À ce stade, distribuer le Web par le code source/paquet local : l’utilisateur installe les dépendances, compile et lance le connecteur sur sa machine. Distribuer Desktop à partir de paquets spécifiques à l’OS et à l’architecture après signature, métadonnées réelles, audit des dépendances et tests sur l’OS concerné. Les artefacts existants sont des builds Linux ARM64 non signés et restent des artefacts de test, non une publication générale.

La sortie `dist/` peut être servie séparément en HTTPS et contient un client de pairing vers le connecteur local. L'interface statique a été publiée sur GitHub Pages avec autorisation; ce site ne contient ni backend d'exécution, ni connecteur, ni projets/clés. Le parcours exige une connexion loopback directe depuis le navigateur, une permission LNA lorsqu'elle est requise, une CSP `connect-src` autorisant la cible et une approbation locale; aucun chemin de proxy cloud ne l'implémente. Le parcours E2E a été réellement exercé sur Chromium 156.0.8078.73 et Firefox 160.0 sous Ubuntu 24.04.5 ARM64, avec association et révocation réussies. Aucun déploiement du connecteur local ou publication de backend Manus n'a été effectué.

## Plan de tests fonctionnels et de sécurité

Les tests existants couvrent le démarrage du connecteur, le refus des binds distants, les réponses santé, le pairing valide/invalide, l'activation locale et son expiration, les limites de dix créations/minute et 32 entrées, les préflights et les routes HTTP cross-origin, les Hosts et Origins hostiles, le refus de lecture/écriture des secrets distants, le self-revoke et la révocation d'une autre origine, la persistance SQLite locale, et les sessions réelles OpenCode 2.2.7 avec Ollama local. Un E2E réel de pairing HTTPS et d'affichage/acceptation du prompt réseau local a été ajouté sous Chromium 156 et Firefox 160 sur Linux ARM64; il ne couvre pas les autres OS/versions ni le refus LNA. Les détails exercés sont dans [`rapport-tests.md`](rapport-tests.md) et [`pairing-https-loopback.md`](pairing-https-loopback.md).

1. **Parcours Web local** : compiler depuis un checkout propre, lancer le connecteur sur l’interface loopback, ouvrir la même origine UI/API, vérifier le pairing, la santé, la liste et l’ouverture d’un projet temporaire, puis confirmer qu’aucune requête ne part vers un hôte cloud. Vérifier les codes 401 pour Bearer absent/invalide et 403 pour Host/Origin hostiles.
2. **Frontière réseau** : vérifier que `127.0.0.1` est le seul bind accepté; tester IPv4 et IPv6 loopback; depuis une seconde machine, confirmer qu’aucune connexion n’est possible; scanner qu’aucun port n’est publié ou transféré.
3. **BYOK et persistance** : utiliser une clé de test uniquement auprès d’un mock fournisseur local, chercher la valeur dans SQLite, backups, fichiers de session, logs, URL, stockage navigateur et archive source; vérifier qu’elle n’y figure pas. Tester rotation et suppression. Tester séparément le coffre OS sur chaque OS pris en charge et refuser de déclarer un coffre durable si le backend est indisponible.
4. **Pairing d’une UI statique** : l'association réelle depuis HTTPS, l'affichage/acceptation du prompt LNA, l'approbation locale et la révocation ont été exercés sous Chromium 156 et Firefox 160 sur Ubuntu 24.04.5 ARM64; l'hôte GitHub Pages courant a permis les requêtes observées, et le détail des statuts HTTP est disponible pour Chromium seulement. Restent à tester le refus LNA, davantage de versions/OS, les politiques CSP/Permissions-Policy d'autres hôtes et configurations, les statuts 401/403 dans chaque navigateur et l'absence de données sensibles sous d'autres profils. Vérifier qu'il n'existe ni wildcard CORS, ni chemin de proxy, ni endpoint/entrée UI qui transmette les API keys.
5. **Desktop** : répéter le smoke test sur les architectures/OS réellement annoncés; tester arrêt/redémarrage, fenêtre renderer sandboxée, choix de dossier, pairing IPC, coffre OS et absence de port réseau externe. Ne pas annoncer une plateforme avant son test natif.
6. **Régression publication** : inspection de configuration en lecture seule; confirmer `server=true`, `database=true`, `deploy` absent et auto-publication désactivée. Ne pas appeler `POST publish` ni créer une cible de déploiement dans le cadre du choix local.

## Limites connues

Le pairing distant a été validé en navigateur HTTPS réel uniquement sur les combinaisons Chromium 156/Ubuntu 24.04.5 ARM64 et Firefox 160/Ubuntu 24.04.5 ARM64. L'invite LNA a été acceptée; un refus, l'appareil Android, les autres versions/OS et les politiques CSP réelles d'autres hébergeurs restent à vérifier. Les permissions Local Network Access ne sont pas identiques dans tous les navigateurs. Le projet Manus courant conserve ses capacités `server` et `database` activées, même si l’application ne les utilise pas; les supprimer nécessiterait une nouvelle architecture/projet, pas un champ de désactivation.

Les paquets Desktop actuellement testés ne couvrent que Linux ARM64, ne sont pas signés et comportent encore les métadonnées provisoires décrites dans le guide de distribution. Les tests de sessions réelles cités dans le rapport utilisent des modèles Ollama locaux; ils ne valident pas l’accès aux comptes fournisseurs distants.

## Références

[1]: https://chromestatus.com/feature/5152728072060928 "Local network access restrictions"
[2]: https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content "Mixed content"
[3]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS "Cross-Origin Resource Sharing"
