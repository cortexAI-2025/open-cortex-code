# Connexion d'une interface HTTPS au connecteur local

**État : implémentation locale et tests de contrat terminés; test navigateur HTTPS/LNA non réalisé.** Cette fonctionnalité est facultative. L'architecture recommandée reste `pnpm build && pnpm start` sur l'appareil utilisateur, ou l'application Desktop. Aucun backend/proxy cloud n'est ajouté. L'hébergement statique n'est pas requis pour utiliser l'application; il sert uniquement son interface compilée.

## Modèle de sécurité

Le connecteur demeure exclusivement lié à `127.0.0.1`. Le navigateur appelle directement `http://127.0.0.1:<port>` depuis l'origine HTTPS courante. Le port est celui configuré pour le connecteur, `4000` par défaut. Aucun hostname alternatif, adresse LAN, tunnel, TLS auto-signé, relais ni proxy n'est admis par le parcours distant.

Les demandes distantes sont **fermées par défaut**. Seul l'utilisateur de l'interface locale peut ouvrir `/api/pair/control` pendant cinq minutes; une origine HTTPS distante ne peut pas activer ni prolonger cette fenêtre. Pendant cette fenêtre, le site peut envoyer `POST /api/pair/requests`; cette demande sans authentification ne donne aucun accès aux données et exige ensuite l'approbation explicite, depuis l'interface locale, de l'origine HTTPS affichée exactement. Le demandeur poll `GET /api/pair/requests/:id`. L'approbation génère un bearer aléatoire lié à l'origine; le jeton n'est livré qu'une fois, reste en mémoire de l'onglet distant et n'est ni mis dans son URL, ni en `localStorage`, ni dans SQLite. L'interface locale peut refuser, afficher les sessions ou les révoquer. Le bouton de déconnexion distant invalide uniquement sa propre session. Les demandes expirent après 2 minutes, le transfert du jeton après 60 secondes et l'autorisation après 30 minutes. Limites actuelles : cooldown de 10 secondes par origine, maximum de 10 nouveaux pairings/minute par connecteur et 32 entrées temporaires. Le mode fermé par défaut atténue l'abus public du quota de demandes non authentifiées.

Les requêtes distantes envoient `credentials: omit`, `mode: cors`, le bearer, une origine CORS exactement réfléchie et aucune redirection. Aucun `Access-Control-Allow-Origin: *` ni `Access-Control-Allow-Credentials` n'est produit. Le preflight initial sans Bearer ne peut demander que le `Content-Type` nécessaire au JSON. Après pairing, `Authorization` et `Content-Type` peuvent être autorisés pour une méthode supportée. `Access-Control-Allow-Private-Network: true` n'est renvoyé que si un preflight le demande avec la valeur `true`. L'origine, la méthode, les headers et le Host sont contrôlés côté serveur; CORS ne remplace jamais le bearer ni l'approbation locale.

Le contrôle DNS-rebinding vérifie chaque `Host` contre les noms loopback attendus pour le port du connecteur (`127.0.0.1`, `localhost`, `[::1]`) et le client distant ne cible que l'IP littérale `127.0.0.1`. Une origine externe avec Host falsifié est refusée. `Origin: null`, une origine non HTTPS, des URL avec chemin/query/fragment/credentials et toute adresse IP distante ne sont pas acceptés pour initier un pairing.

Les routes de création, lecture et écriture de profils/credentials fournisseur, secrets MCP et secrets API REST sont refusées aux origines distantes, et leurs formulaires sont absents/en lecture seule dans cette UI. Il faut gérer BYOK, les credentials MCP/API et le coffre exclusivement depuis l'application locale. Les profils distants ne révèlent pas les valeurs de secrets. Le connecteur local ne passe pas les clés par un serveur Manus; il les transmet seulement au fournisseur choisi lorsque l'utilisateur utilise ce modèle.

**Limite de confiance importante :** une page hébergée exécute du JavaScript contrôlé par son origine. Après approbation, ce JavaScript peut lire les fichiers, diffs et messages que l'utilisateur consulte dans cette interface et pourrait tenter de les exfiltrer. Les formulaires de clés sont bloqués côté client et serveur, mais cela ne protège pas contre une compromission ou une mise à jour malveillante de l'hébergeur pouvant modifier le JavaScript. La liaison directe évite un proxy backend dans le fonctionnement normal; elle ne garantit pas la confidentialité du code vis-à-vis de l'opérateur d'une page distante compromise. Ne pas approuver une origine à laquelle le contenu de projet ne peut être confié. Pour ces projets, préférer le Web local ou Desktop.

## Installation et utilisation locale

1. Sur l'appareil qui détient le projet, installer les dépendances, compiler, puis lancer `pnpm build && pnpm start`. Le connecteur écoute sur `127.0.0.1:4000` par défaut et sert lui-même `dist/` et son API sous la même origine.
2. Pour l'usage recommandé, ouvrir le lien local imprimé par le connecteur ou utiliser Desktop. Ce mode n'a pas besoin de CORS vers un site distant.
3. Pour tester une interface statique distante, construire `pnpm build:web`, servir le contenu `dist/` depuis une origine HTTPS contrôlée par l'utilisateur, et régler **sur cet hébergement** une CSP `connect-src` qui autorise l'origine de l'UI et le loopback choisi (par exemple `http://127.0.0.1:4000`). L'hébergeur peut également imposer une Permissions-Policy qui bloque le réseau local; ne pas désactiver les protections pour contourner ce refus. Aucun hébergement ni configuration manusienne n'est créé ici.
4. Sur le même appareil, ouvrir aussi le Web local ou Desktop, aller à Paramètres > Connexion et choisir « Autoriser 5 min ». L'ouverture requiert une confirmation et se ferme automatiquement au bout de cinq minutes.
5. Depuis le même navigateur, ouvrir l'UI HTTPS, saisir `http://127.0.0.1:4000`, confirmer la confiance dans l'origine exacte affichée puis choisir « Demander l’approbation locale ». Si la fenêtre locale est fermée ou expire, le serveur refuse la demande; réouvrez-la localement puis réessayez.
6. Le navigateur peut demander la permission Local Network Access. Si l'utilisateur la refuse, si le CSP bloque `connect-src`, ou si le navigateur ne permet pas le fetch HTTPS→loopback, le parcours ne fonctionne pas. Utiliser le Web local ou Desktop; ne pas activer de flags, retirer des protections, accepter un certificat auto-signé ou ouvrir un tunnel.
7. Dans l'UI locale, examiner le domaine complet et approuver ou refuser. Après acceptation, le tab HTTPS obtient un jeton éphémère. Pour retirer le droit avant son expiration, utiliser « Déconnecter » depuis l'UI distante ou « Révoquer » dans l'UI locale.

Le site distant et le connecteur doivent être vus par le **même navigateur/appareil** : `127.0.0.1` désigne l'appareil exécutant le navigateur, non le poste où tourne l'hébergeur, le sandbox Manus ou une machine voisine. L'interface distante ne fonctionne pas comme un relay vers un autre appareil.

## Matrice de compatibilité — connaissances, non certification

| Navigateur / environnement | État documentaire au 12 novembre 2026 | Statut de ce produit |
|---|---|---|
| Chrome/Chromium Desktop 142+ | Le billet Chrome indique Local Network Access avec prompt de permission depuis Chrome 142 pour les requêtes d'un site public vers des destinations locales depuis un contexte sécurisé. La protection exige le consentement navigateur. | Support protocolaire plausible; pas de test du build produit depuis un vrai domaine HTTPS, pas de prompt réellement observé. À valider par version/OS. |
| Chromium Desktop avant 142 | Les mécanismes et phases antérieurs (dont Private Network Access expérimental) diffèrent; ne pas inférer la présence du prompt LNA de 142. | Non certifié. Utiliser Web local/Desktop si le navigateur bloque. |
| Firefox Desktop 153+ | Mozilla indique une protection LNA activée par défaut et une permission utilisateur dans Firefox Desktop 153. | Source consultée; parcours du produit non testé. |
| Safari macOS | Aucune source WebKit officielle confirmant ici un équivalent Safari applicable au flux HTTPS→loopback. Cette absence n'établit pas une impossibilité. | Non vérifié; aucune promesse. Tester une version native avant de l'annoncer. |
| Chrome Android, Firefox Android, Safari iOS/iPadOS | Les sources consultées et les tests de cette livraison ne certifient pas ces plateformes mobiles ni leurs permissions système. | Non vérifié. Le client utilisé pour la tâche est Manus Android; cette UI embarquée et l'accès à un service loopback Android n'ont pas été testés. |
| WebViews / navigateur intégré d'une application | Les permissions et politiques réseau peuvent différer du navigateur complet et de l'OS. | Non vérifié. Préférer Web local ou Desktop; ne pas supposer que la Preview Web embarquée peut accéder au connecteur de l'appareil. |

## Tests et résultats

**Exécutés localement :** tests Node du gestionnaire de pairing (fenêtre fermée par défaut, activation/expiration locale, rate limits 10/min et capacité 32, validation origine, expiration, délivrance unique, hash/token, liaison exacte, refus/révocation); test HTTP du vrai connecteur sur port loopback, qui refuse une activation distante; preflight avec et sans `Access-Control-Request-Private-Network`; origine CORS exacte sans cookies/wildcard; Host DNS-rebinding falsifié; absence de Origin; refus d'un jeton sur une autre origine; refus remote de lire/écrire credentials BYOK, MCP et REST; révocation de sa session et refus de supprimer celle d'une autre origine; test client URL/credentials/cookies/redirect; TypeScript et compilation Web/server/Desktop. Ces tests exécutent les routes et les headers serveur, mais **n'émulent pas l'interface de permission LNA du navigateur**.

**Non exécutés :** fetch réel d'un domaine HTTPS contrôlé vers le connecteur local, invite de permission, refus navigateur, CSP/Permissions-Policy d'un hôte réel, Android/manus WebView, Safari, essai réseau entre deux appareils, scan d'une installation distribuée, publication de `dist/`. Aucun résultat ne doit être déduit du seul fait que la suite HTTP est verte.

Procédure de test navigateur à effectuer avant annonce de compatibilité : utiliser une origine HTTPS de test dont le code est contrôlé, connecter un connecteur local sur une fixture temporaire, observer le prompt LNA et le preflight dans DevTools, approuver/refuser l'origine côté connecteur, vérifier les statuses 401/403 et l'absence de secrets dans Storage/URL, puis tester l'expiration, le self-revoke, les flux d'écriture secrets et la reprise d'onglet. Refaire sur chaque version/OS de la matrice sans flags navigateur ni certificat invalide.

## Références

- Chrome, *Making local network requests safer for users*: https://developer.chrome.com/blog/local-network-access
- MDN, `Permissions-Policy: local-network-access`: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/local-network-access
- Mozilla Support, *Control personal device local network permissions in Firefox*: https://support.mozilla.org/en-US/kb/control-personal-device-local-network-permissions-firefox
- MDN, *Mixed content*: https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content
- MDN, *Cross-Origin Resource Sharing (CORS)*: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS
- GitHub Security Lab, *Localhost dangers: CORS and DNS rebinding*: https://github.blog/security/application-security/localhost-dangers-cors-and-dns-rebinding/
- Détails des sources et limites : [`recherche-pairing-navigateur.md`](recherche-pairing-navigateur.md)
