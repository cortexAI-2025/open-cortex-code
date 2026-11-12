# Sources vérifiées — pairing navigateur vers loopback

Date de consultation : 12 novembre 2026. Cette note conserve les observations externes utiles au pairing HTTPS→`127.0.0.1`. Elle ne prétend pas remplacer les essais dans des versions navigateur déterminées.

## Chrome et Chromium

Le billet d'adoption Chrome, publié le 9 juin 2025 et mis à jour le 29 septembre 2025, indique le lancement de l'invite Local Network Access à partir de Chrome 142. La permission protège les requêtes d'un site public vers des destinations locales, y compris des applications tournant sur le poste, et n'est demandable qu'à partir d'un contexte sécurisé. Le billet définit les loopbacks IPv4/IPv6 comme destinations concernées. Il confirme que Local Network Access a remplacé l'expérimentation Private Network Access mise en pause. L'exemption de contenu mixte s'applique aux destinations localement identifiables par IP privée ou au mécanisme `targetAddressSpace`; les autres navigateurs peuvent différer. Source : https://developer.chrome.com/blog/local-network-access

La page MDN `Permissions-Policy: local-network-access` classe l'ancienne directive comme expérimentale et recommande de vérifier la table de compatibilité avant un usage production. Elle renvoie aux directives plus récentes `local-network` et `loopback-network`. Source : https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/local-network-access

## Firefox

L'article Mozilla Support, actualisé le 7 octobre 2026, affirme que Firefox Desktop 153 active par défaut les protections Local Network Access et demande la permission lorsqu'un site public tente d'accéder aux applications/services du poste ou aux appareils du réseau local. Il donne aussi des commandes `about:config` capables de désactiver ou affaiblir les protections; le produit ne les utilisera ni ne les recommandera. Source : https://support.mozilla.org/en-US/kb/control-personal-device-local-network-permissions-firefox

## HTTPS, HTTP local et CORS

MDN précise que `fetch()` et XHR vers HTTP depuis HTTPS sont normalement du contenu mixte bloquable. Elle indique également que les ressources loopback telles que `http://127.0.0.1/` et `http://localhost/` sont traitées comme des origines sécurisées dans les mécanismes d'origine fiable; cela ne suffit pas à établir une compatibilité identique de chaque navigateur avec une requête API cross-origin. Source : https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content

MDN CORS décrit le preflight `OPTIONS` pour les requêtes cross-origin qui incluent notamment des en-têtes non safelistés. Le preflight annonce la méthode et les en-têtes envisagés; le serveur doit autoriser explicitement l'origine, la méthode et les en-têtes. Le Bearer `Authorization` de la requête finale n'est pas disponible pour authentifier ce preflight. Source : https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS

## DNS rebinding et confiance

GitHub Security Lab rappelle que les règles CORS ne sont pas une authentification, que les origines doivent être comparées exactement et que l'origine `null` ne doit pas être inscrite dans une allowlist. Son article analyse DNS rebinding sur des serveurs locaux et recommande de vérifier le Host contre des hôtes locaux approuvés. Source : https://github.blog/security/application-security/localhost-dangers-cors-and-dns-rebinding/

## Safari et lacune de validation

Les recherches documentaires effectuées ici n'ont pas trouvé de source officielle WebKit confirmant une permission Safari équivalente à LNA pour la requête concernée. Cela ne prouve pas que Safari bloque systématiquement cette architecture; la compatibilité reste non établie et requiert un essai réel sur la version supportée, sans certificat auto-signé ni désactivation de protections.
