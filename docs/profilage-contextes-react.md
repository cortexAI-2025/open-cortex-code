# Profilage React des contextes isolés

**Date :** 15 novembre 2026
**Environnement :** Chromium 156.0.8078.73, React et React DOM 19.3.1, Vite en mode développement.

## Conclusion

Le profilage après extraction de `unsaved` et `connecting` confirme trois cas d’isolation. Sur 12 notifications, la fonction `App` ne s’est pas rendue dans la variante à hooks ciblés, contre 12 rendus avec `useApp()`. Sur 12 changements isolés d’`unsaved`, `App` ne s’est pas rendue non plus dans la variante ciblée, contre 12 rendus dans la variante agrégée. Lors de l’échec loopback, les deux transitions de `connecting` ne rendent plus `App` ciblée (0 contre 2 rendus agrégés). Les composants descendants explicitement abonnés au statut restent réactifs.

Pour les mises à jour que `App` consomme effectivement — navigation et mode agent — les deux variantes se rendent comme attendu et leurs médianes sont pratiquement identiques. Le profilage ne montre donc pas de gain général artificiel sur chaque interaction; le bénéfice observé est l’évitement des rendus étrangers au domaine modifié.

## Méthode

Le profilage monte deux copies du composant `App` actuel sous deux `AppProvider` indépendants, dans le même navigateur et le même serveur Vite. Les copies ont le même arbre UI; seule la manière de s’abonner à l’état varie :

- **Hooks ciblés :** les hooks spécifiques utilisés par `client/App.tsx` (`useConnection`, `useWorkspace`, `useAgent`, `useNavigation`, etc.).
- **Agrégé :** le même composant et le même code de rendu, mais ses valeurs de contexte sont lues au moyen de `useApp()`.

Un compteur temporaire dans chaque copie mesure les appels à la fonction `App`; un `React.Profiler` englobe le sous-arbre réel de chaque copie. Pour l’essai de connexion, le script navigue réellement vers Settings et attend le montage de `ConnectionPanel`. Des copies temporaires instrumentées comptent ses appels de fonction et un `React.Profiler` supplémentaire mesure uniquement son sous-arbre. Le script échauffe les deux variantes, puis effectue 12 changements pour les notifications, la navigation, le mode agent et le drapeau de brouillon non enregistré. L’ordre des variantes est alterné.

Le cas connexion est séparé : après montage vérifié de la vue Settings, le script vérifie que `127.0.0.1:49151` est fermé, puis effectue une vraie tentative HTTP locale qui échoue. Aucun connecteur n’est simulé; ce cas ne teste pas une connexion réussie au moteur. Le jeton de test n’est pas envoyé sur `/api/health`.

## Résultats

Les temps sont en millisecondes de rendu React, non le temps de bout en bout. « Total » et « médiane » couvrent les commits de la période mesurée; le nombre de rendus concerne directement la fonction `App`.

| Mise à jour | App — hooks ciblés | App — `useApp()` agrégé | Médiane Profiler — ciblés / agrégé | Lecture |
|---|---:|---:|---:|---|
| Notification, 12 changements | **0 rendu** | **12 rendus** | **0,40 / 14,25 ms** | Temps total profilé 5,2 / 173,5 ms; descendants ciblés comme `NoticeBanner` se mettent toujours à jour. |
| Navigation, 12 changements | 12 / 12 | 12 / 12 | 18,75 / 18,90 ms | Les deux variantes se mettent à jour car `App` lit la vue active. |
| Mode agent, 12 changements | 12 / 12 | 12 / 12 | 16,10 / 16,05 ms | Les deux variantes se mettent à jour car `App` affiche le mode. |
| `unsaved`, 12 changements — après extraction | **0 rendu** | **12 rendus** | **1,80 / 15,45 ms** | Temps total 21,4 / 186,9 ms (−88,5 % pour le sous-arbre profilé dans cette exécution). Les descendants abonnés au statut produisent toujours 12 commits ciblés. |
| Échec loopback, Settings affichée | **0 rendu** | **2 rendus** | **4,10 / 19,10 ms** | `ConnectionPanel` a lui-même 2 rendus dans chaque variante; son sous-arbre : médiane 2,30 / 2,30 ms, total 4,6 / 4,6 ms. |

À titre de comparaison, avant l’extraction, le même scénario `unsaved` comptait 12 appels à `App` dans les deux variantes (médiane ciblée : 20,60 ms; temps total : 225,1 ms). Après extraction, les appels à `App` ciblé tombent à zéro. Les temps sont sensibles à l’ordonnancement et à l’activité du navigateur; le compte de rendus de la fonction `App` est le signal structurel le plus robuste.

Pour l’action connexion, `App` ciblée n’est pas relancée par les transitions de `connecting`, mais `ConnectionPanel` reçoit bien deux rendus dans chaque variante, via son abonnement à `useConnecting()`. Son sous-arbre mesuré totalise 4,6 ms et sa médiane est 2,30 ms dans les deux variantes, avec deux commits dans chaque cas. Cela ne montre pas de réduction du travail de `ConnectionPanel` due au seul découplage d’`App`; les deux mises à jour maintiennent l’indicateur et le bouton cohérents. Le signal `connected` reste faux et ce résultat n’est pas une mesure de connexion réussie.

## Interprétation et pistes

La séparation des domaines fonctionne comme prévu pour les mises à jour de notification, de brouillon et de connexion transitoire : le consommateur racine n’est plus abonné à ces états indépendants, tandis que les descendants qui en dépendent continuent à se mettre à jour. La valeur `unsaved` et la commande `setUnsaved` sont dans des contextes distincts; le Workbench n’écoute que la commande. `connecting` dispose de son propre contexte `ConnectingDomain`, consommé par `ConnectionPanel`. Le profilage ciblé établit maintenant que les deux transitions rendent ce panneau deux fois dans les deux variantes; ces mises à jour sont pertinentes pour son UI, pas des rendus manifestement superflus.

L’isolation de `unsaved` et `connecting` est appliquée dans `state.tsx` et les consommateurs pertinents. Les changements navigation et mode agent sont pertinents pour `App` et doivent continuer à produire leurs mises à jour.

## Limites

- Les mesures proviennent de React/Vite **en développement**. `actualDuration` mesure le travail de rendu React, pas le calcul de style, le layout, la peinture, les images, les requêtes ou la fluidité perçue. Elles ne doivent pas être présentées comme des mesures de production.
- La variante agrégée est un contrefactuel contrôlé généré à partir de l’`App.tsx` actuel en remplaçant uniquement ses abonnements par `useApp()`; ce n’est pas un checkout de l’ancien commit.
- Deux arbres sont montés dans un navigateur headless. Cela permet une comparaison contrôlée, mais ne représente pas la charge d’un grand projet, d’une longue session ou d’un poste utilisateur donné.
- Le scénario de connexion est un échec loopback contrôlé, sans service répondant. Il ne vérifie ni le pairing, ni OpenCode, ni les performances d’une connexion réussie.
- L’instrumentation du scénario connexion porte sur la racine `App`, la fonction `ConnectionPanel` et le sous-arbre de ce panneau; les autres interactions restent mesurées au niveau App/sous-arbre global, pas composant par composant.

## Formulaire Integrations : mesure avant/après isolation

Le formulaire de création MCP/API a été extrait dans `IntegrationForm`, un sous-composant `memo`. Les états de champs — nom, type, URL, commande, méthode, endpoint, headers, nom du secret, secret et autorisation loopback — lui appartiennent désormais. La vue `Integrations` conserve l’onglet, l’état occupé, le dernier résultat, les permissions et les rafraîchissements. Pendant la frappe, le parent contenant les listes ne se rend donc plus; le sous-composant de formulaire demeure réactif. Le secret reste un état mémoire local au formulaire et est effacé au changement d’onglet et avant l’envoi.

Le même script CDP a été exécuté trois fois avant et trois fois après le refactoring. Chaque exécution saisit 21 caractères dans le champ « Nom MCP » et mesure `Integrations`, `IntegrationForm` et le sous-arbre React. Voici les moyennes des trois exécutions :

| Mesure par séquence de 21 caractères | Avant | Après | Écart observé |
|---|---:|---:|---:|
| Appels à `Integrations` | 22 | **0** | **−100 %** |
| Appels à `IntegrationForm` | — | 22 | Le formulaire reste contrôlé; le premier caractère produit deux rendus, puis un par frappe. |
| Commits du sous-arbre profilé | 22 | 22 | Nombre inchangé |
| Durée React totale moyenne | 66,37 ms | 39,83 ms | **−40,0 %** |
| Médiane par commit, moyenne des runs | 3,05 ms | 1,90 ms | **−37,7 %** |
| p95 par commit, moyenne des runs | 3,83 ms | 2,13 ms | **−44,3 %** |

Les totaux avant étaient de 65,0, 64,7 et 69,4 ms; après : 39,8, 39,7 et 40,0 ms. Ce sont des durées `actualDuration` React, pas du temps de bout en bout. La réduction signifie que le coût React profilé du sous-arbre visible a diminué dans ce scénario; le gain structurel principal est que la fonction parent et son rendu des listes sont exclus des mises à jour de frappe.

Le harness monte la vraie vue et instrumente des copies temporaires. Sans projet ni connecteur, il retire uniquement dans ces copies `ProjectGate` et le garde `remote` afin de rendre le formulaire local visible; `api` reste nul. Il ne valide ni ne soumet le formulaire et ne simule aucun serveur, succès ou résultat d’intégration. Au chargement, le comportement normal d’`AppProvider` émet un `GET /api/health` loopback sans jeton; le serveur Vite ne configure pas de proxy API. Les listes MCP/API sont vides; des listes réelles volumineuses peuvent modifier les coûts absolus. La mesure a été faite sous React/Vite en développement, donc elle ne prédit pas directement les performances de production.

## Reproduction

Avec les dépendances installées et le serveur Vite local disponible sur `http://127.0.0.1:3000` :

```sh
node scripts/profile-context-domains.mjs
node scripts/profile-integrations-form.mjs
```

Options : `CONTEXT_PROFILE_URL` pour l’URL de Vite et `CONTEXT_PROFILE_ITERATIONS` pour le nombre d’interactions (3 à 100) du premier script. Les deux scripts créent des fichiers temporaires uniques dans le projet pendant le profilage et les suppriment à la fin; le script de contextes vérifie aussi que son port loopback de stimulus est libre. Ils ne modifient pas les composants de production.

## État des modifications

Les fixtures temporaires ont été supprimées après chaque exécution. Les livrables reproductibles sont `scripts/profile-context-domains.mjs` et `scripts/profile-integrations-form.mjs`; le rapport est ce document. Le refactoring `IntegrationForm` est couvert par `tests/integrations-isolation.test.tsx`. Aucun test de connexion OpenCode réussie n’a été déclaré. Aucun commit, push, merge ou déploiement n’a été effectué.
