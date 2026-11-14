# Analyse du bundle Web

Le projet intègre Rollup Visualizer pour examiner la composition du build client, sans lancer d'outil dans le navigateur ni téléverser le rapport.

Depuis la racine du dépôt, exécuter :

```sh
pnpm analyze:bundle
```

La commande lance le build Vite en mode `analyze` et écrit une carte en treemap dans `dist/bundle-report.html`. Le rapport indique les tailles des modules/chunks ainsi que les estimations gzip et Brotli. Ouvrir ce fichier localement dans un navigateur pour explorer les modules.

L'analyse est désactivée lors de `pnpm build:web` et `pnpm build`; elle n'ouvre pas automatiquement de navigateur. Le rapport est un artefact généré sous `dist/`, pas un fichier source à publier. Il concerne le bundle client Vite : il ne mesure pas la taille du serveur Node, du paquet Electron complet, ni le temps de téléchargement observé sur un réseau réel.

## Optimisation du chargement Monaco

Monaco et Workbench sont maintenant chargés à la première ouverture de la vue Éditeur avec `React.lazy()` et `Suspense`. L'entrée globale n'importe plus Monaco statiquement. Workbench reste monté quand il est masqué afin de préserver son état local. La configuration des workers dans `client/monaco.ts` est conservée.

### Résumé mesuré — 13 novembre 2026

Sur Chromium `156.0.8078.73`, build servi localement sans compression HTTP, le JavaScript du démarrage est passé de **4 395 130 o à 347 233 o décodés** (−92,10 %). Le premier clic Éditeur a demandé quatre chunks supplémentaires, totalisant **4 055 421 o** et mesurés en **441 ms** dans ce run. Le cumul après ouverture atteint **4 402 654 o**, soit légèrement plus que le build monolithique initial : le travail réduit le coût à froid en déplaçant le chargement, il ne prétend pas réduire le transfert total de Monaco.

Les chiffres détaillés, la méthode, les limites et le résultat des contrôles sont dans le [rapport d'optimisation Monaco](optimisation-monaco.md).

### Test de navigateur reproductible

Après `pnpm build`, exécuter `pnpm test:monaco-browser`. Ce test sert `dist/`, démarre Chromium et utilise le vrai code de l'application, sans fixture projet ni fichier de test. Il mesure le chargement différé, vérifie que la même instance Workbench survit au masquage/retour, bloque réellement les requêtes JavaScript pour provoquer l'alerte d'erreur, puis vérifie qu'un retry réussi restaure l'éditeur. Il requiert Chromium dans le `PATH` ou le chemin `CHROMIUM_PATH`; le profil isolé temporaire est nettoyé à la fin.

Le smoke test antérieur des workers a utilisé des modèles temporaires en mémoire pour vérifier diagnostics et complétions TypeScript, JavaScript, CSS, HTML et JSON. Ce résultat vérifie le moteur Monaco, mais ce parcours distinct n'est pas exercé par le nouveau test E2E sans fichier connecté.

### Limites du build

La sortie garde des chunks volumineux : `ts.worker` (6 927 851 o bruts, 1 483 002 o gzip estimés), `editor.api` (2 735 533 o bruts, 695 751 o gzip estimés) et `css.worker` (1 078 350 o bruts, 244 745 o gzip estimés). Ces ressources demeurent émises et peuvent être demandées lorsqu'un fichier correspondant est ouvert; elles sont séparées du chargement initial. L'avertissement Vite n'a pas été masqué en augmentant le seuil.
