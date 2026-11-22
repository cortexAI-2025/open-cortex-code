# Équipe IA : intégration du CTO IA (AiWorkPay)

Open Cortex Code est l'environnement central ; le **CTO IA** (dépôt `AiWorkPay-SASU/CTO-AI-AIWORKPAY`) reste un processus indépendant
qui possède l'orchestration (délégation à l'architecte, au backend, à QA et à Sécurité), l'exécution des tests et la revue.
Open Cortex ne planifie, ne délègue et n'exécute rien lui-même : il **transmet, suit, présente et fait approuver**.
Deux dépôts, deux processus, aucun orchestrateur dupliqué.

```
Fondateur → Open Cortex Code (UI « Équipe IA » + connecteur) ──HTTP S2S──▶ CTO IA ─▶ architecte → backend → QA ∥ Sécurité
                                          ▲                                  └─ tests + revue + branche Git + rapport de PR
                                          └──── événements, coûts, tests, preuves Git, demandes d'approbation
```

## Configuration (côté connecteur uniquement)

| Variable | Rôle |
|---|---|
| `CORTEX_CTO_URL` | URL du CTO IA : HTTPS, ou HTTP loopback. Pas d'identifiants dans l'URL, réseaux privés distants refusés. |
| `CORTEX_CTO_TOKEN` | Jeton bearer propriétaire du CTO (`CTO_ADMIN_TOKEN` de l'autre côté), 24 caractères minimum. |

Le jeton ne quitte jamais le connecteur : absent des réponses, de SQLite, de l'historique et des journaux (coffre mémoire + masquage), jamais transmis aux agents.
Un jeton « lecture seule » du CTO permet de consulter mais pas de créer, approuver ni annuler (`CTO_READ_ONLY`).
Le CTO doit travailler sur le dépôt du projet ouvert (`CTO_REPO_PATH` = chemin du projet) : sinon `CTO_REPO_MISMATCH`.

## Routes ajoutées (toutes derrière le pairing habituel)

| Route | Rôle |
|---|---|
| `GET /api/cto/team` | Connexion (`connected`/`unreachable`/`unauthorized`/`not_configured`), rôle d'accès, isolation réelle (`READY`/`BLOCKED`/`UNKNOWN`), les quatre spécialistes et leur état. |
| `POST /api/cto/register` `{confirm:true}` | Enregistre le CTO comme agent superviseur (après vérification : joignable, quatre spécialistes présents). Persistant. |
| `GET /api/projects/:id/cto/missions` | Missions du projet (rafraîchies au mieux ; sinon dernier état connu marqué `stale`). |
| `POST /api/projects/:id/cto/missions` | `{repo, objective, budgetUsd?, acceptanceCriteria?, acceptanceTests?, scope?, idempotencyKey?, confirm:true}`. |
| `GET /api/projects/:id/cto/missions/:missionId` | Mission, tâches par agent, rapports, événements, coûts par rôle, tests, preuves Git, rapport de PR. |
| `POST …/approvals` | `{kind:'mission'\|'architecture'\|'completion', decision:'approve'\|'reject', note?, confirm:true}` — seulement si le CTO a réellement demandé cette approbation. |
| `POST …/cancel`, `POST …/resume` | `{confirm:true}`. |

## Garanties

- **Pas de double exécution.** L'identifiant de mission Open Cortex est la clé d'idempotence (`external_ref`) côté CTO. La correspondance est
  enregistrée **avant** l'envoi. Réponse perdue après acceptation, coupure avant acceptation, redémarrage, reprise lancée deux fois en parallèle :
  la reprise rattache la mission existante (recherche par `external_ref`) ou la transmet une seule fois. Testé.
- **BLOCKED plutôt que simulé.** Avant toute création, le pont exige que le CTO ait vérifié son isolation (Linux, Node, CLI Claude, test réel
  de bubblewrap) ; sinon `409 CTO_BLOCKED` et rien n'est créé. L'isolation est présentée comme « namespaces bubblewrap », **jamais** comme conteneur Docker certifié.
- **Validation humaine.** Mission, plan d'architecture et livraison finale demandent chacun une approbation explicite (`confirm:true` + boîte de confirmation).
  Aucune approbation n'est envoyée sur un état périmé.
- **Aucune action Git distante.** Le CTO prépare une branche locale et un corps de PR ; poussée, PR distante et fusion restent à la charge du propriétaire
  (le rapport affiche `pushed:false, merged:false`). Aucun déploiement.
- **Périmètre.** `scope` est appliqué par le CTO sur l'arbre final ; un fichier hors périmètre renvoie la tâche en correction.
- **Budget.** Plafond par mission et par tâche côté CTO ; coûts par rôle remontés, estimations explicitement signalées.

## Tests

`tests/cto-bridge.test.ts` (double de contrat HTTP : coupures, doublons, reprise, redémarrage, secrets, lecture seule, BLOCKED) et
`tests/team-view.test.tsx` (vue). Avec `CTO_REPO_DIR=/chemin/CTO-AI-AIWORKPAY`, un test supplémentaire exerce le **vrai** orchestrateur du CTO
(agents scriptés, vrai dépôt Git). La mission pilote avec Claude réel est documentée dans `docs/mission-pilote-cto.md`.

## Démarrage (les deux services)
```bash
(cd /chemin/CTO-AI-AIWORKPAY && npm run setup:linux)          # bubblewrap + vérification réelle du runtime (npm run doctor)
CTO_DIR=/chemin/CTO-AI-AIWORKPAY scripts/team-up.sh /chemin/du/projet   # démarre le CTO puis Open Cortex, attend leur santé
```
La configuration (`~/.opencortex/team.env`, mode 600) est créée au premier lancement avec un jeton généré localement ; elle persiste. Le CTO travaille sur le projet passé en argument,
qui doit être ouvert dans Open Cortex. Preuve d'une exécution complète avec correction autonome : [certification-equipe-ia.md](certification-equipe-ia.md).
