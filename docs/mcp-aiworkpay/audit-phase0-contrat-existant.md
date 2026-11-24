# Phase 0 — Audit du MCP AIWORKPAY existant (lecture seule)

Date : 2026-11-24. Statut : **audit, aucune implémentation**. Il remplace la prémisse de l'audit architectural initial (« aucune spécification n'existe ») : **une infrastructure MCP AIWORKPAY existe, documentée, testée et branchée sur un vrai backend.** L'audit initial reste valable pour la partie « côté CTO / Open Cortex » (voir [audit-architectural-initial.md](audit-architectural-initial.md)).


## 1. Méthode et limites
- **Lu** (lecture seule, aucun appel à un service AIWORKPAY) : le code et la documentation des dépôts listés au § 2.
- **Exécuté** : typecheck et **97 tests** du serveur MCP sur une copie jetable (API simulée en mémoire, aucun appel réseau vers AIWORKPAY) → tous réussis. Les tests de bout en bout (qui exigent le backend) et le test de démarrage réel n'ont **pas** été lancés.
- **Non vérifiable depuis cet environnement** : `mcp.aiworkpay.fr`, `aiworkpay.fr`, `app.aiworkpay.fr` (résolution DNS impossible). **Je ne présume donc ni leur disponibilité, ni la version déployée, ni les outils réellement exposés en production.** Le contrat ci-dessous est celui du **code** (`main`), pas celui d'un déploiement observé.
- Aucune clé AIWORKPAY n'a été utilisée ni demandée. Aucun fichier d'environnement n'a été lu.
- Chaque affirmation cite un fichier ou un test ; ce qui est une inférence est dit.

## 2. Cartographie des dépôts
| Dépôt | Visibilité | Rôle réel | État observé | Verdict |
| --- | --- | --- | --- | --- |
| `aiworkpay-mcp-server` | public | Serveur MCP v0.7.0 : 13 outils, transports stdio et HTTP, garde-fous | `main` à jour (11 nov.), 97 tests OK ; **branche par défaut périmée** (5 oct., 25 commits de retard) | **Base de l'intégration** (travailler sur `main`) |
| `Aiworkpay-v2` | privé | Backend (Next.js, Prisma, PostgreSQL, Stripe) : API agent, console, administration | Plusieurs branches d'intégration | Source de vérité de l'API ; **non modifiée, lecture seule** |
| `AIWorkPay-SDK-v1` | public | SDK Python 2.0 (sync/async, webhooks) | Branche par défaut en retard de 24 commits sur `integration/sdk-v2` | Hors besoin direct du CTO (Node) ; référence de contrat |
| `AIWorkPay-OpenAI-Agents-Plugin-v1` | public | Plugin OpenAI Agents | **Marqué obsolète et incompatible par ses auteurs** (API `/tasks` inexistante) | **À ne pas utiliser** |
| `agent-aiworkpay` | public | Agents Python (planificateur, délégateur…) | Client sur l'ancienne API `/tasks` | **Obsolète** |
| `asp-aiworkpay` | public | Agent autonome TypeScript + module `MissionControl` (arrêt d'urgence, alertes, résumé quotidien) | Client sur l'ancienne API `/tasks` ; concepts de supervision intéressants | Source d'idées, **code non réutilisable tel quel** |
| `aiworkpay` | privé | Application Vite/React + Supabase, modèle « wallet / lots d'exécutions » | Modèle de données **différent** du backend v2 | Référence de sécurité citée par le MCP ; **ne pas confondre avec le backend v2** |

« MissionControl » : il en existe deux, sans lien — celui du CTO IA (interface web du CTO) et celui d'`asp-aiworkpay` (supervision locale d'un agent autonome). Aucun « MissionControl » n'a été trouvé dans le backend ni dans le MCP.

**Non examinés** (hors périmètre ou sans rapport apparent) : les autres dépôts des deux organisations (applications, sites, outils).

**Dérive de branches à corriger côté AIWORKPAY** : la branche par défaut du MCP, du backend et du SDK n'est pas la branche qui fait foi (MCP : `main` ; SDK : `integration/sdk-v2`). Une intégration qui clone « par défaut » récupère du code périmé (c'est arrivé pendant cet audit). Les documents du MCP renvoient en outre vers d'anciens emplacements de dépôts.

## 3. Inventaire du contrat MCP (v0.7.0, `main` @ `37b9150`)
**Serveur** : `aiworkpay`, SDK MCP officiel, instructions intégrées. **Transports** : stdio (une clé par processus, via l'environnement) ou Streamable HTTP sans état (`POST /mcp`, la clé de l'agent dans `Authorization: Bearer awp_…`, contrôle `Host`/`Origin`, `GET /healthz`).
**Le MCP est une couche fine** : aucune logique de paiement ni de statut ; chaque outil = un appel HTTPS vers le backend avec la clé de l'agent.

### 3.1 Outils réellement enregistrés (13, vérifiés dans le code)
| Outil | Écrit ? | Effet / entrées principales |
| --- | --- | --- |
| `create_mission` | oui | Aperçu (`confirm=false`, **aucun appel réseau**) puis création (`confirm=true`) → `mission_id`, `status: awaiting_payment`, `payment_url` (Stripe Checkout, à payer par un humain). Entrées : `type`, `title`, `instructions`, `budget`, `currency`, `deadline`, `priority`, `location?`, `deliverables?`, `client_reference?`, `confirm` |
| `get_mission`, `get_mission_status` | non | Détail ; statut + `next_action`, retard (`is_past_deadline`) |
| `list_missions` | non | Missions **de cette clé**, filtre par statut, pagination |
| `get_mission_result` | non | `available`, `validated`, `delivered_at`, `note`, `data`, `proofs[]`, **`content_warning`** (donnée externe non fiable) |
| `get_proof_file` | non | Preuve (image rendue comme image, PDF intégré, 15 Mo max, état antivirus) ; l'URL d'une pièce n'est **jamais suivie** |
| `approve_result` | **oui, irréversible** | Paie le Payworker (90 %). Aperçu puis `confirm` |
| `request_changes` | oui, sans argent | Renvoie au même Payworker avec un commentaire ; **3 fois au maximum** |
| `cancel_mission` | oui | Avant qu'un Payworker ne la prenne : ferme le paiement ou rembourse. Aperçu puis `confirm` |
| `get_account`, `list_transactions` | non | Permissions, plafonds, budget restant, plafond effectif ; paiements et remboursements |
| `prepare_workforce_handoff`, `get_workforce_handoff` | non | **Interface d'orchestration** : référence stable `ruflo-<hash(swarm,task,handoff)>`, phases `awaiting_payment` / `waiting_for_worker` / `awaiting_review` / `completed` / `canceled`, `poll_after_seconds` (300), `ready_to_resume` |

Sorties : `content` (texte JSON) **et** `structuredContent`. Erreurs : `isError` + `{code, message, source, http_status, request_id, retryable, retry_after_seconds, hint}`.

### 3.2 Statuts et transitions (agent)
`awaiting_payment → open → assigned → in_progress → delivered → completed`, ou `canceled`. Une mission en retard prise par un Payworker n'est **jamais** annulée automatiquement ; elle est signalée en retard et résolue par l'équipe AIWORKPAY. Annulation par l'agent : seulement avant l'engagement d'un Payworker.

### 3.3 Authentification et permissions
Clé `awp_…` par agent (le MCP ne la stocke ni ne la journalise), HTTPS obligatoire hors localhost. Permissions portées par la clé et appliquées par le backend : `missions:read`, `missions:write` (créer, annuler), `missions:approve` (valider et payer, ou demander des corrections) ; refus `INSUFFICIENT_SCOPE`. Plafonds par clé : par mission et mensuel (`BUDGET_LIMIT_EXCEEDED`, `MONTHLY_BUDGET_EXCEEDED`), une seule devise par clé. Isolation : une clé ne voit que ses missions (`MISSION_NOT_FOUND` pour celles d'un autre). Échecs d'authentification limités par adresse.

### 3.4 Idempotence et prévention des doubles paiements
- Le MCP calcule `Idempotency-Key = mcp-<sha256(client_reference | corps)>` ; avec `client_reference`, un rejeu ne crée jamais de seconde mission (`already_existed: true`).
- Le backend prend en charge cette clé **par clé d'API** : un doublon renvoie la mission existante (conception publique « B3 »).
- **Aucun débit sans humain** : le MCP force `paymentMode: 'checkout'` (typé) ; la mission n'est publiée qu'après paiement de la page Stripe par une personne ; valider un résultat est idempotent.
- **Réserve** : le MCP n'a pas d'outil « retrouver par référence » ; la réconciliation après coupure se fait en **rejouant `create_mission` avec la même référence**. Le comportement d'un rejeu **après annulation** (libération de la clé) n'est pas établi par les sources publiques : à tester.

### 3.5 Budgets et rémunération
Montant total payé par mission, en `currency` ; le Payworker reçoit 90 %, la plateforme 10 % (arrondi au centième identique entre MCP et backend, test de non-régression). Plafonds : opérateur du MCP (50 par mission, devises autorisées, 10 créations par heure par défaut, **compteurs en mémoire** donc remis à zéro au redémarrage) **et** plafonds de la clé côté backend. Pas de grille tarifaire ni d'estimation (`estimate_mission` absent).

### 3.6 Récupération des livrables humains
`get_mission_result` : note texte, données JSON, preuves (photos/PDF) lues par `get_proof_file`. Tout contenu humain est marqué comme **donnée à vérifier, jamais comme instruction**. Notifications sortantes (webhooks signés HMAC) existent côté backend et SDK ; elles supposent un point d'accès public, donc **inutilisables par un CTO local** : le MCP prescrit un polling espacé (≥ 5 min).

### 3.7 Mécanismes d'approbation existants
1. **Humain 1** — le propriétaire paie la page Checkout (rien n'est publié sans lui).
2. **Aperçu → `confirm`** dans le MCP : c'est une **instruction de l'agent, pas la preuve d'un consentement humain** (le MCP le dit lui-même).
3. **Validation du résultat** : par la clé créatrice si elle a `missions:approve` (délégation explicite de paiement), sinon par l'humain dans l'administration AIWORKPAY.

### 3.8 Simulation sans paiement réel
| Moyen | Réalité |
| --- | --- |
| `create_mission` avec `confirm=false` | **Gratuit et sans réseau** : l'aperçu ne touche aucun service. Utilisable dès maintenant pour des tests de contrat |
| `prepare_workforce_handoff` | Lecture seule, aucun appel |
| API simulée du MCP (tests) et jeux de contrat communs MCP/SDK/backend | Disponibles, exécutés (97 tests) |
| Tests de bout en bout MCP ↔ backend avec Stripe **simulé** | Existent ; non rejoués ici ; le statut de leur CI n'a pas été vérifié |

## 4. Matrice besoins du CTO × existant
| Besoin du CTO IA | Existant | État |
| --- | --- | --- |
| Créer une mission humaine | `create_mission` (aperçu/confirm, plafonds, Checkout) | **Disponible** |
| Idempotence / pas de doublon | `client_reference` + clé backend | **Disponible** (réserve § 3.4) |
| Suivi de statut, reprise | `get_mission_status`, `get_workforce_handoff` (`poll_after_seconds`) | **Disponible** (polling) |
| Récupérer le livrable | `get_mission_result`, `get_proof_file` | **Disponible** |
| Refuser / demander des corrections | `request_changes` (3 max) | **Disponible** (nécessite `missions:approve`) |
| Annuler | `cancel_mission` (avant prise) | **Disponible** (limité) |
| Plafonds de dépense | clé + opérateur MCP | **Disponible** ; compteurs MCP volatils |
| Résultats non fiables | `content_warning`, aucun suivi d'URL | **Disponible** côté MCP ; **vérification à faire côté CTO** |
| Séparer « déléguer » de « payer » | `missions:approve` séparable **mais** l'approbation exige la clé créatrice | **Partiel / incompatible** (G1) |
| Approbation humaine liée au contenu exact du brief | Aucun | **Manquant** (à construire côté CTO/Open Cortex) |
| Retrouver une mission par référence | Aucun outil | **Manquant** (contournable par rejeu) |
| Notifications push vers un CTO local | Webhooks publics seulement | **Incompatible** → polling |
| Compte de dépense Payworker distinct du coût modèle | `get_account`, `list_transactions` | **Partiel** : données disponibles, journal à construire |
| Pause globale / arrêt d'urgence des délégations | Aucun côté AIWORKPAY ; concept dans `asp-aiworkpay` | **Manquant** (à construire côté CTO) |
| Environnement de test sans paiement réel | Aperçu, API simulée, jeux de contrat | **Partiel** (pas de préproduction jouée) |

## 5. Écarts, risques, prérequis
### 5.1 Incompatibilités et écarts majeurs
- **G1 — Qui valide et paie ?** La validation exige la clé qui a créé la mission. Donner `missions:approve` au CTO lui permettrait de payer sans humain (inacceptable : « les agents de développement n'ont pas d'accès financier »). Ne pas le lui donner laisse la validation à l'**administration AIWORKPAY** (humain, hors Open Cortex). Open Cortex ne peut donc pas **approuver** un paiement sans modification côté AIWORKPAY.
- **G2 — Notifications** inutilisables en local ⇒ polling (latence de l'ordre de 5 min, acceptable pour du travail humain).
- **G3 — Leviers de sécurité en mémoire** : limiteurs du MCP volatils ; le CTO doit tenir son propre compteur persistant.
- **G4 — `confirm=true` n'est pas un consentement** : le CTO ne doit l'envoyer qu'après une approbation humaine liée au brief.
- **G5 — Données exposées** : une mission publiée est visible des Payworkers ; le brief ne doit **jamais** contenir de code source, de secret ni de donnée confidentielle (à imposer côté CTO).
- **G6 — Environnement de test** : aucune préproduction jouée ⇒ aucune mission payante avant sa validation.
- **G7 — Production du MCP non vérifiable** depuis ici (version, outils exposés, durcissement). Le démarrage de production impose des garde-fous (nombre de proxys, secret partagé…), pertinents pour un déploiement HTTP, pas pour un MCP lancé en local.
- **G8 — Hygiène des dépôts** : branches par défaut périmées, dépôts obsolètes (`/tasks`) qui prêtent à confusion.

### 5.2 Risques de sécurité propres à l'intégration
Double paiement après coupure (couvert par idempotence + rejeu), injection par le résultat ou une preuve image/PDF (donnée non fiable, QA/Sécurité, jamais exécutée), fuite de clé (variable d'environnement serveur du CTO uniquement ; **jamais** dans les agents Claude — leur environnement est une liste blanche qui exclut `AIWORKPAY_*`), exposition de données dans le brief (G5), dépassement de budget (plafonds de clé réglés bas + plafond CTO), clé partagée entre agents (une clé dédiée au CTO), auto-inscription d'agents (désactivée par défaut côté backend : à laisser désactivée).

### 5.3 Prérequis techniques
Node ≥ 20 (déjà requis par le CTO) ; **SDK MCP** (`@modelcontextprotocol/sdk`, épinglé par le MCP) ou client JSON-RPC minimal : le CTO a aujourd'hui **zéro dépendance npm**, c'est une décision à prendre (D2). Une clé AIWORKPAY dédiée, bornée (`missions:read` + `missions:write`, plafonds bas, devise unique, expiration). Un point d'accès de test (préproduction ou instance locale).

### 5.4 Modifications souhaitables côté AIWORKPAY (à votre décision, aucune réalisée)
1. **Séparer l'approbation de la création** : autoriser une clé « approbateur » rattachée au même propriétaire humain à valider/refuser les missions des clés qu'il a créées, ou une route d'approbation par jeton signé du propriétaire (résout G1 sans donner le paiement au CTO).
2. Outil/route de **recherche par `client_reference`**.
3. **Mode de paiement forcé `checkout` par clé** (défense en profondeur côté backend, en plus du MCP).
4. Aligner les **branches par défaut** et archiver les dépôts obsolètes.
5. Option : webhooks vers un relais public, si un jour le polling ne suffit plus.

## 6. Boucle humaine cible
Deux dimensions, toutes deux **orchestrées par le CTO** et **présentées / approuvées dans Open Cortex** :
1. **Délégation aux Payworkers** : tâche non-LLM `human` exécutée par le code de l'orchestrateur derrière un port étroit (`create`, `status`, `result`, `cancel`, `requestChanges`), adaptateur MCP. Approbation fondateur `human_delegation` (aperçu exact du brief, plafond, données exposées, hash du brief) **avant** tout `confirm=true`, puis paiement Checkout par le propriétaire (second verrou natif), puis vérification du résultat (CTO + QA/Sécurité) avant acceptation.
2. **Supervision et validation humaines du travail des agents IA** : déjà en place (approbations mission / architecture / livraison, interface Équipe IA). À ajouter : pause globale des délégations, résumé quotidien, délais et escalade, inspirés du `MissionControl` d'`asp-aiworkpay` (concepts uniquement).

**Frontière stricte** : les quatre agents de développement (Claude) n'ont ni clé, ni outil MCP, ni accès réseau vers AIWORKPAY ; seul le code d'orchestration appelle le port, avec un jeton lu dans son environnement serveur.

## 7. Architecture d'intégration fondée sur l'existant
```
Fondateur ─ Open Cortex (Équipe IA : carte « délégation humaine », brief, plafond, payment_url, résultat)
              │ approbations (confirm, hash du brief) — flux existant Open Cortex → CTO
              ▼
         CTO IA (orchestrateur)
           ├─ agents de dev Claude : AUCUN accès AIWORKPAY
           └─ HumanWorkPort ──(MCP stdio local, ou HTTP)──► aiworkpay-mcp-server (main, version épinglée)
                                                              └─HTTPS + clé « CTO » (read+write, plafonds bas)──► backend AIWORKPAY
Validation du résultat / paiement : humain, côté AIWORKPAY (G1) — jamais le CTO
```
Choix : le CTO est le **seul client MCP** (les agents ne le sont pas) ; le MCP reste inchangé ; on **réutilise** `client_reference` (dérivée de `missionId`, `taskId` et empreinte du brief), `get_workforce_handoff` pour les phases et `poll_after_seconds`, `content_warning` pour le traitement des résultats. Le CTO conserve son propre registre (handle, brief approuvé, dépenses engagées) car les limiteurs du MCP sont volatils.

## 8. Feuille de route révisée (une PR par phase, validation du propriétaire entre chaque phase)
| Phase | Contenu | Critères d'acceptation | Tests | Coût |
| --- | --- | --- | --- | --- |
| **0. Décisions** | D1–D6 (§ 10) ; clé et point d'accès de test ; épingler le MCP (`main`, version) | Décisions écrites ; aucune clé dans un dépôt | Revue | 0 |
| **1. Contrat figé** | Manifeste des 13 outils (schémas) généré depuis le MCP épinglé, rejoué en test de contrat ; aperçus `create_mission` (`confirm=false`) | Manifeste versionné ; une dérive de version fait échouer le test ; aucun appel réseau | Contrat + aperçu sans réseau | 0 |
| **2. Port + double** | `HumanWorkPort`, double de contrat conforme à la phase 1, tâche `human`, états d'attente persistants (aucun bail d'exécution pendant des jours) | Machine d'états complète ; reprise après `kill -9` sans doublon | Unitaires + interruption | 0 |
| **3. Approbation `human_delegation`** | Nouveau type, aperçu du brief, lien au hash, carte Open Cortex, plafond par mission et global, revue du brief (secrets, code) | Aucune création sans approbation fraîche ; brief modifié ⇒ ré-approbation ; refus ⇒ annulation | Tests de pont (état périmé, rejeu, hash) + vue | 0 |
| **4. Adaptateur MCP vs API simulée** | Client MCP du CTO contre le MCP lancé sur son API simulée / harnais de bout en bout ; `client_reference` ; rejeu ; annulation ; `request_changes` | Rejeu = même mission ; coupure après envoi réconciliée par rejeu ; **rejeu après annulation testé** ; aucun `confirm=true` hors approbation | Contrat, kill -9 pendant `create`, double envoi | 0 |
| **5. Résultats** | Ingestion (texte/JSON), preuves en quarantaine, schéma/taille/type, secrets, QA/Sécurité, rejet / re-délégation bornés | Résultat piégé rejeté et journalisé, jamais exécuté ; délais et expiration explicites | Jeux de résultats hostiles | 0 |
| **6. Supervision** | Pause globale, résumé quotidien, escalade, registre des dépenses Payworker (devise propre) | Dépassement ⇒ blocage ; pause effective < 1 tick ; dépenses visibles | Plafonds, pause, journal | 0 |
| **7. Validation Stripe + décision G1** | Recette de paiement en mode test **par le propriétaire** ; choix de la solution G1 (modification AIWORKPAY ou validation par l'administration) | Recette signée ; G1 tranché et testé | Recette, bout en bout | hors périmètre |
| **8. Pilote réel minimal** | Une mission humaine, plafond fixé par le propriétaire, approbations réelles | Cycle complet prouvé, preuves archivées | Mission pilote documentée | plafond fixé par vous |

Chaque phase garde verts les 173 + 117 tests actuels et ne modifie pas le chemin validé Open Cortex → CTO → quatre agents.

## 9. Verdict
- **Début de l'intégration (phases 0 à 6, sans argent) : GO**, après votre validation de ce plan et des décisions D1–D6. L'infrastructure existe, son contrat est précis, testable sans réseau, et couvre l'essentiel des besoins.
- **Toute mission payante réelle : NO-GO** tant que : la recette de paiement en mode test n'est pas confirmée comme réussie par le propriétaire, G1 n'est pas tranché, une clé dédiée bornée n'existe pas, et la production du MCP (`mcp.aiworkpay.fr`) n'est pas vérifiée.
- **Utilisation des dépôts obsolètes (plugin OpenAI, `agent-aiworkpay`, `asp-aiworkpay` en tant que client) : NO-GO.**

## 10. Décisions à prendre
- **D1** Boucle humaine : confirmez que le périmètre est bien (a) délégation aux Payworkers **et** (b) supervision/validation, dans cet ordre.
- **D2** Dépendance : accepter le SDK MCP comme première dépendance npm du CTO (épinglée, isolée), ou client JSON-RPC minimal maison.
- **D3** G1 : valider le paiement par l'administration AIWORKPAY (aucun changement), ou demander la modification « approbateur séparé » (§ 5.4-1).
- **D4** Transport : MCP local (stdio, recommandé pour le pilote) ou HTTP distant (après vérification de la production).
- **D5** Plafonds du pilote (par mission, mensuel, devise) et durée de validité de la clé.
- **D6** Préproduction : qui joue la recette de paiement en mode test, et quand.

## Annexe — Références vérifiables
| Élément | Référence |
| --- | --- |
| MCP | `main` @ `37b9150` (v0.7.0), tests : 97 réussis (hors e2e) ; branche par défaut périmée @ `0b81552` |
| SDK | défaut @ `d4e9aa6` ; `integration/sdk-v2` @ `b27b979` (+24) |
| Plugin OpenAI | `b389634` (obsolète) |
| `agent-aiworkpay` / `asp-aiworkpay` | `be94b36` / `18ea56e` (avril 2026, API `/tasks`) |
