# Mission pilote réelle : Open Cortex Code → CTO IA → agents Claude

Exécutée le 2026-11-22 sur un dépôt temporaire jetable (`/tmp/pilot/repo`, `main` = `b4f9800`). Aucun correctif statique, aucune réponse simulée :
les quatre agents sont de vraies sessions du CLI Claude (modèle `claude-sonnet-5-5`), lancées par le vrai CTO, pilotées par le vrai connecteur Open Cortex.
Journal brut : [pilot/pilot-log.txt](pilot/pilot-log.txt). Capture de l'interface : [pilot/equipe-ia-mission-pilote.png](pilot/equipe-ia-mission-pilote.png).

## Scénario (objectif : `parseDuration(text)` dans `src/duration.js` + tests, périmètre `src` et `test`, budget 3 USD)
| # | Étape | Résultat observé |
|---|---|---|
| 1 | Fondateur crée la mission depuis l'API Open Cortex (même route que la vue Équipe IA) | mission `a4f52465…` créée, `pending_approval` |
| 2 | Le CTO la reçoit | rattachée à la mission CTO `dbcaf2c3…` via `external_ref` |
| 3 | L'architecte produit un plan | accepté, 0,220 USD, plan relu avant approbation |
| 4 | Approbations demandées par le CTO | `mission` puis `architecture` approuvées via Open Cortex (par moi, sur dépôt jetable, selon la consigne du pilote) ; `completion` **laissée en attente** |
| 5 | Backend écrit du code avec Claude | `src/duration.js` (33 lignes) + `test/duration.test.js` (63 lignes), 1 essai, 0 correction, 0,131 USD |
| 6 | Le CTO exécute les tests lui-même (bubblewrap) | projet 10/10, tests d'acceptation du propriétaire (invisibles de l'agent) 8/8 |
| 7 | QA et Sécurité en parallèle | QA `pass` (0 constat) ; Sécurité `pass`, 2 constats *low* (valeurs non bornées, entrée recopiée dans les messages d'erreur), non bloquants |
| 8 | Vérification CTO | statut `review`, `completion` demandée |
| 9 | Branche et rapport de PR | branche locale `cto/dbcaf2c3/backend-227d82ca`, commit `672c2f7`, rapport de PR généré ; poussée : non, fusionnée : non |
| 10 | Open Cortex affiche | tâches par agent, coûts, tests, revues, preuves Git, événements, bouton d'approbation (capture) |

Durée totale agents : 36 s après la dernière approbation. **Coût réel : 0,581 USD sur 3 USD** (architecte 0,220 ; backend 0,131 ; QA 0,115 ; sécurité 0,115).

## Vérifications indépendantes (hors CTO)
- `main` du dépôt de test inchangé (`b4f9800`), le travail n'existe que sur la branche de tâche.
- Worktree détaché du commit, `node --test` lancé à la main : 10/10 ; fichier d'acceptation lancé à la main : 8/8.
- Redémarrage d'Open Cortex après la mission : la mission, son rattachement, l'enregistrement du superviseur et les résultats sont retrouvés ; aucun doublon.
- Le jeton CTO n'apparaît dans aucune réponse du connecteur ; le contenu des tests d'acceptation du propriétaire n'est pas renvoyé au navigateur.
- Le pilote a révélé un défaut du pont (le résultat des tests d'acceptation était filtré avec les tests du propriétaire) : corrigé, avec test de régression.

## Limites
La boucle de correction et le renvoi après revue n'ont pas été déclenchés en réel (tout est passé du premier coup) : ils sont couverts par les tests du CTO avec agents scriptés.
Isolation : namespaces bubblewrap (user/pid/net/mount, capacités retirées), **pas** un conteneur Docker ; Docker n'a pas été exécuté.
Les approbations du pilote ont été données par l'assistant sur dépôt jetable ; en usage réel elles restent des décisions du fondateur.
