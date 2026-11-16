# Chargement différé des vues secondaires

**État : implémenté et mesuré — 14 novembre 2026.**

`App.tsx` charge désormais avec `React.lazy()` les vues **Integrations**, **Models**, **Automations**, **Skills** et **Memory**. Elles ont chacune un boundary `Suspense` avec un état d’attente accessible. Si l’import dynamique échoue, l’interface indique la vue concernée et propose de recharger l’application. Les vues restent protégées par `ProjectGate` comme avant; aucun connecteur, projet ou profil LLM n’est simulé pour le test.

## Mesures avant/après

Le build de référence a été mesuré avant cette modification à partir du même worktree local; le build après est celui qui contient le découpage. Les deux ont été construits par Vite/Rollup Visualizer. Les compressions gzip sont calculées à niveau 9 et Brotli avec la même bibliothèque Python dans les deux cas.

| Mesure | Avant | Après | Écart |
|---|---:|---:|---:|
| Bundle d’entrée JavaScript, brut | 347 233 o | 300 613 o | −46 620 o (−13,43 %) |
| Bundle d’entrée, gzip niveau 9 | 103 883 o | 92 182 o | −11 701 o (−11,26 %) |
| Bundle d’entrée, Brotli | 89 407 o | 79 675 o | −9 732 o (−10,89 %) |
| JavaScript réellement chargé à froid dans Chromium, octets décodés | 347 233 o / 1 fichier | 309 152 o / 2 fichiers | −38 081 o (−10,97 %) |
| Charge initiale, gzip par fichier (somme des fichiers initiaux) | 103 883 o | 95 479 o | −8 404 o (−8,09 %) |
| Charge initiale, Brotli par fichier | 89 407 o | 82 624 o | −6 783 o (−7,59 %) |
| Fichiers JavaScript émis | 97 | 104 | +7 fichiers |
| Ensemble JavaScript émis, brut | 14 343 339 o | 14 346 396 o | +3 057 o (+0,02 %) |
| Somme gzip niveau 9 des fichiers JavaScript émis individuellement | 3 431 180 o | 3 438 232 o | +7 052 o (+0,21 %) |

Après séparation, le navigateur charge à froid `index-BXiGhbZ7.js` (300 613 o) et le chunk commun React `react-sySUN5R7.js` (8 539 o). C’est pourquoi le gain réel mesuré au démarrage est inférieur à la baisse du seul fichier d’entrée. Les tailles gzip/Brotli des fichiers initiaux sont calculées séparément par fichier : elles ne représentent pas une capture de transfert sur un CDN réel.

Les cinq chunks de vues ajoutés sont les suivants :

| Vue | Brut | gzip niveau 9 | Brotli |
|---|---:|---:|---:|
| Integrations | 9 967 o | 3 699 o | 3 327 o |
| Models | 10 007 o | 3 469 o | 3 122 o |
| Automations | 6 964 o | 2 656 o | 2 402 o |
| Skills | 6 824 o | 2 593 o | 2 310 o |
| Memory | 6 903 o | 2 750 o | 2 455 o |

**Conclusion :** la charge JavaScript initiale baisse d’environ 11 % en brut dans le parcours Chromium testé, tandis que l’ensemble des fichiers JavaScript émis reste pratiquement identique et augmente légèrement (+0,02 % brut). Ce changement reporte le téléchargement des vues; il ne constitue pas une baisse équivalente du téléchargement total.

## Vérification navigateur

`pnpm test:secondary-views-browser` construit des contrôles sur les fichiers émis, démarre un serveur statique local et lance Chromium avec un profil temporaire et le cache désactivé. Il vérifie que les cinq chunks existent et qu’aucun n’est demandé au démarrage à froid, puis navigue vers **Models** et confirme le chargement réel du chunk différé. Sur Chrome `156.0.8078.73`, le démarrage a chargé deux fichiers JavaScript pour 309 152 octets décodés. L’ouverture de Models a ensuite chargé deux fichiers supplémentaires (10 382 octets décodés) en 23–32 ms lors des deux exécutions locales; le chunk Models lui-même fait 10 007 octets. Ce temps n’est pas une promesse de latence réseau.

Les vues Integrations, Automations, Skills et Memory sont derrière `ProjectGate`. Le test ne fabrique pas de connecteur ni de projet : il vérifie que leurs chunks sont bien émis et absents du parcours froid, mais ne prétend pas tester leur chargement avec un projet réel. Pour les exercer en navigateur, une connexion locale et un projet de test explicitement autorisé seraient nécessaires.

## Contrôles exécutés

- `pnpm analyze:bundle` — réussi; treemap généré localement dans `dist/bundle-report.html`.
- `pnpm build` — réussi (Web, serveur Node et Desktop).
- `pnpm typecheck` — réussi.
- `pnpm test` — 86 tests réussis sur 86.
- `pnpm test:monaco-browser` — réussi; instance Workbench conservée et reprise après échec du chargement toujours vérifiées.
- `pnpm test:secondary-views-browser` — réussi.

L’avertissement de taille Vite sur les chunks Monaco/éditeur subsiste et n’a pas été masqué; il est distinct de cette optimisation.


## Seconde vague : Settings et panneaux du tiroir — 14 novembre 2026

`Settings` est maintenant chargé avec `React.lazy()` lors de l’ouverture de cette vue. `CommandPanel` et `GitPanel` ne sont importés qu’à la demande, lorsque le tiroir est ouvert sur l’onglet correspondant et que `ProjectGate` autorise l’affichage. Les trois chargements affichent un état d’attente accessible; en cas d’échec d’import, l’interface propose de recharger l’application. Aucun composant existant n’a été remplacé.

### Comparaison avant/après

La référence est le même worktree juste avant cette vague d’optimisation, après le chargement différé des cinq vues précédentes. Les tailles de fichiers sont mesurées sur les builds locaux; gzip est calculé fichier par fichier au niveau 9 et Brotli fichier par fichier. Les octets du navigateur sont les tailles décodées observées sur le serveur statique local sans compression HTTP.

| Mesure | Avant | Après | Écart |
|---|---:|---:|---:|
| Entrée JavaScript, brut | 300 613 o | 288 586 o | −12 027 o (−4,00 %) |
| Entrée JavaScript, gzip niveau 9 | 92 182 o | 88 517 o | −3 665 o (−3,98 %) |
| Entrée JavaScript, Brotli | 79 675 o | 76 925 o | −2 750 o (−3,45 %) |
| JavaScript réellement chargé à froid dans Chrome, décodé | 309 152 o | 297 125 o | −12 027 o (−3,89 %) |
| Ressources initiales, gzip par fichier | 95 479 o | 91 814 o | −3 665 o (−3,84 %) |
| Ressources initiales, Brotli par fichier | 82 624 o | 79 874 o | −2 750 o (−3,33 %) |
| Fichiers JavaScript émis | 104 | 108 | +4 |
| Total JavaScript émis, brut | 14 346 396 o | 14 348 245 o | +1 849 o (+0,013 %) |

Les trois chunks visés sont bien séparés dans le build : `Settings-CGSLhUbz.js` (**3 422 o**), `CommandPanel-B5ZtAyez.js` (**3 374 o**) et `GitPanel-CF1VObgy.js` (**6 808 o**). Le volume total émis reste presque inchangé; le gain concerne la charge à froid, et non une réduction équivalente du téléchargement total.

### Vérification navigateur et limites

`pnpm test:secondary-views-browser` a réussi sur Chrome `156.0.8078.73`. Le chargement à froid a demandé deux fichiers JavaScript pour **297 125 octets décodés**. La navigation vers Settings a ensuite chargé un fichier supplémentaire de **3 422 octets**; le délai observé de **320 ms** est local et ne prédit pas une latence réseau Internet. Le même test vérifie que les chunks Settings, CommandPanel et GitPanel sont émis et absents du chargement froid.

Le test n’invente pas de connecteur ni de projet. Comme `ProjectGate` empêche le rendu de `CommandPanel` et `GitPanel` sans connexion locale et projet réel, le chargement navigateur de ces deux panneaux après ouverture du tiroir n’a pas été exercé dans cette campagne. Leur découpage est vérifié par les chunks émis, et leur absence du démarrage est vérifiée en Chromium.

`pnpm build`, `pnpm typecheck`, `pnpm test` (**86/86**), `pnpm test:secondary-views-browser` et `pnpm test:monaco-browser` ont réussi. Les avertissements Vite sur les gros chunks Monaco/éditeur subsistent; le seuil n’a pas été augmenté et aucune bibliothèque n’a été remplacée. Le treemap final est dans `dist/bundle-report.html`.
