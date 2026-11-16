# Optimisation du chargement Monaco

**Date : 13 novembre 2026 — branche `optimization/monaco-lazy-loading`**

## Résumé

Monaco et Workbench sont désormais différés jusqu'à la première ouverture de la vue Éditeur. L'application principale n'importe plus `client/monaco.ts` ni Workbench statiquement. `DeferredWorkbench` utilise `React.lazy()` et `Suspense`, affiche un statut accessible durant le chargement, et conserve la même instance Workbench lorsqu'on navigue vers une autre vue puis revient. Si l'import asynchrone échoue, une alerte expose une action « Réessayer »; le nouveau chargement est effectivement testé dans Chromium après blocage puis rétablissement des requêtes JavaScript.

La configuration des workers dans `client/monaco.ts` n'a pas été remplacée ni réduite. Monaco, React DOM, Lucide et les workers existants sont conservés.

## Mesures avant/après

Les deux versions ont été comparées sur un build de production, avec Chromium `156.0.8078.73`, un profil vierge et une origine HTTP locale sans compression. Les octets navigateur indiqués sont donc les tailles décodées des réponses, et non la taille d'un transfert HTTP gzip/Brotli. Les mesures gzip ci-dessous sont calculées hors navigateur avec gzip niveau 9. Une ouverture de l'éditeur ajoute des téléchargements différés : il ne faut pas interpréter le gain du démarrage comme une réduction équivalente du volume total.

| Mesure | Avant | Après | Écart |
|---|---:|---:|---:|
| JavaScript demandé au démarrage, brut | 4 395 130 o | 347 233 o | −4 047 897 o (−92,10 %) |
| Bundle d'entrée, gzip niveau 9 | 1 120 686 o | 103 883 o | −1 016 803 o (−90,73 %) |
| Fichiers JavaScript émis | 93 | 97 | +4 fichiers |
| Total JavaScript émis, brut | 14 335 662 o | 14 343 339 o | +7 677 o (+0,054 %) |
| Somme des gzip niveau 9 fichier par fichier | 3 423 435 o | 3 431 180 o | +7 745 o (+0,226 %) |

Le total émis inclut les workers. La somme gzip est la somme de fichiers compressés séparément; ce n'est pas une mesure du transfert cumulé sur une session utilisateur.

Au premier clic Éditeur du test automatisé final, Chromium a chargé **4 fichiers JavaScript supplémentaires**, totalisant **4 055 421 o décodés**, en **444 ms** dans cet environnement :

| Chunk chargé lors de l'ouverture | Octets décodés |
|---|---:|
| `monaco-…js` | 1 297 375 o |
| `dist-…js` | 13 937 o |
| `editor.api-…js` | 2 735 533 o |
| `Workbench-…js` | 8 576 o |

Après cette ouverture, le volume JavaScript cumulé observé est de **4 402 654 o**, soit **7 524 o (+0,171 %)** de plus que l'ancien chargement monolithique. Le changement déplace donc l'essentiel du coût au moment où l'utilisateur ouvre l'éditeur; il ne prétend pas réduire le téléchargement total de Monaco. Pour les utilisateurs qui n'ouvrent pas l'éditeur, le bundle de démarrage évite ce transfert différé.

## Test automatisé reproductible

Le nouveau test `scripts/test-monaco-browser.mjs` exécute l'application construite depuis `dist/`, sans projet de démonstration, sans fixture de fichier et sans connecteur. Il démarre un serveur statique local et un profil Chromium temporaire qu'il supprime à la fin. Il vérifie que Workbench est absent avant l'ouverture, mesure les modules chargés au premier clic, navigue hors de l'éditeur puis y revient en vérifiant l'identité de la même instance DOM, bloque réellement les requêtes `.js` pour contrôler l'alerte d'échec, puis les réautorise et vérifie que « Réessayer » charge Workbench.

Commande, après le build :

```sh
pnpm build
pnpm test:monaco-browser
```

Chromium doit être installé; si son exécutable n'est pas dans le `PATH`, `CHROMIUM_PATH` permet de l'indiquer. Le test ne modifie ni les projets utilisateurs, ni le connecteur local, ni les clés BYOK.

Résultat final observé : Chrome `156.0.8078.73`; 1 fichier JavaScript au démarrage (347 233 o); 4 chunks ajoutés à la première ouverture (4 055 421 o); 444 ms mesurés; même instance Workbench conservée lors de la navigation; le scénario de panne a bloqué 4 requêtes de chunks, affiché l'alerte, puis récupéré avec succès après retry.

## Workers, fonctionnalités et limites

La route de chargement différé continue d'importer le bootstrap `client/monaco.ts` avant Workbench, et le fichier de dispatch des workers n'a pas été modifié. Le test navigateur précédent de la campagne a chargé les workers et observé diagnostics/complétions pour TypeScript, JavaScript, CSS, HTML et JSON. Ce parcours de langage utilisait des modèles temporaires en mémoire et n'est pas la nouvelle commande reproductible; le nouveau smoke test se concentre volontairement sur le produit réel et n'ouvre pas de fichier faute de projet connecté.

L'assertion de conservation de l'état vérifie que la même instance Workbench demeure montée, ce qui préserve ses états React locaux pendant les changements de vue. Elle ne valide pas, dans ce smoke test sans projet, la conservation d'un brouillon de fichier réellement ouvert ni de son état Git.

Les chunks restent volumineux dans la sortie de build, notamment `ts.worker` (6 927 851 o bruts, 1 483 002 o gzip) et `editor.api` (2 735 533 o bruts, 695 751 o gzip). Ils sont émis mais chargés à la demande; cette optimisation ne les remplace pas et ne masque pas l'avertissement de taille. Il s'agit d'une mesure de chargement initial, pas d'une optimisation du poids total de Monaco.

## Validation finale

- `pnpm analyze:bundle` — réussi.
- `pnpm build` — réussi.
- `pnpm typecheck` — réussi.
- `pnpm test` — 86 tests réussis (6 fichiers de tests).
- `pnpm test:monaco-browser` — réussi sous Chrome `156.0.8078.73`.
- `git diff --check` — propre avant préparation du commit local.

Aucune fusion, aucun push et aucun déploiement n'ont été effectués.


## État de livraison — 14 novembre 2026

La mention précédente indiquant qu'aucun push, aucune fusion et aucun déploiement n'avaient été effectués décrivait l'état au moment de la validation locale initiale du 13 novembre. Le 14 novembre, après validation spécifique, la [PR brouillon Monaco-only #1](https://github.com/cortexAI-2025/open-cortex-code/pull/1) a été ouverte vers la branche `main`. Elle reste non fusionnée; aucun déploiement n'a été effectué.
