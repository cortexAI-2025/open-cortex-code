> **Mise à jour (Phase 0, 2026-11-24).** Ce rapport a été écrit **avant** l'audit des dépôts AIWORKPAY. Sa prémisse — « aucune spécification du MCP AIWORKPAY n'existe » — est **inexacte** : un serveur MCP existe, documenté et testé. Ses sections 0, 3.x et 4 sur le MCP sont **remplacées** par [audit-phase0-contrat-existant.md](audit-phase0-contrat-existant.md). Reste valable : l'analyse des interfaces **côté CTO IA et Open Cortex** (approbations, idempotence, permissions, reprise) et le modèle de menaces.

# Audit architectural en lecture seule — intégration du MCP AIWORKPAY

Date : 2026-11-24. Base : Open Cortex Code `main` (`52f318a`), CTO IA `main` (`faba557`). Lecture seule : aucun code écrit, aucun MCP connecté, aucune dépense, aucun déploiement.

## 0. Limite fondamentale de cet audit
**Aucune spécification du MCP AIWORKPAY, des Payworkers ni de la délégation de missions humaines n'existe dans les deux dépôts** (recherche sur `main` et sur les branches ouvertes du CTO ; la seule occurrence de « MCP » est le plan de découverte `MCP_ATLAS.md`, sans rapport) **et aucun serveur de ce nom n'est disponible dans cette session**. Les sections 3 et 4 décrivent donc ce que **notre côté** offre déjà et ce qu'il faudra construire ; tout ce qui dépend du contrat AIWORKPAY (outils, schémas, authentification, webhooks, clés d'idempotence, tarification) est une **hypothèse marquée « H »** à confirmer (section 7). Je n'ai rien inventé comme fait.

Vocabulaire retenu : « délégation de missions humaines » = confier une tâche à un **Payworker (humain rémunéré)** via le MCP AIWORKPAY, puis récupérer et vérifier son résultat. À ne pas confondre avec « Human-on-the-Loop » (supervision humaine d'un système autonome) : le CTO a déjà des approbations humaines ; la boucle humaine à développer reste à définir (question Q1).

## 1. Principe directeur
`CTO-AI-AIWORKPAY` est l'équipe de **développement logiciel**, distincte de la workforce métier AiWorkPay (charte du dépôt). L'intégration ne doit pas fusionner ces deux mondes : le MCP AIWORKPAY est un **service externe dont les entrées/sorties sont non fiables**, qui peut **engager de l'argent et exposer des données à des humains**. Il relève donc du régime « action sensible » (fondateur), pas du régime « outil d'agent ».

## 2. Interfaces existantes réutilisables
| Besoin | Existant (preuve) | Réutilisable tel quel ? |
|---|---|---|
| Machine à états de mission | `MISSION_TRANSITIONS`, `TASK_TRANSITIONS` (`src/core.js:7,19`) ; `awaiting_owner`, `blocked`, `review` | Oui, extension par un nouveau type de tâche |
| Approbations humaines | `APPROVAL_KINDS = mission, architecture, completion` (`src/cto.js:17`), table `approvals` auditée, états `pending_approval` / `awaiting_owner` / `review` | Mécanisme oui ; il manque un **type d'approbation par délégation / dépense** |
| Pont d'approbation côté UI | `approvalSchema` + `confirm:true` + refus sur état périmé (`server/advanced/cto-bridge.ts:192`) ; vue Équipe IA | Oui (ajout d'un `kind`) |
| Idempotence | `external_ref` (`createMission`/`getMissionByRef`, `src/cto.js:72`) + verrou par clé ; correspondance persistante côté Open Cortex | Modèle à **répliquer** pour l'appel MCP (clé dérivée de l'id de tâche) |
| Reprise sur interruption | file durable à baux, `recoverExpired` (`src/queue.js`), `resume` (`src/cto.js:216`) ; testé en réel (kill -9 → un seul retry) | Oui ; une tâche « humaine » est **longue** : le bail doit devenir un état d'attente persistant, pas un bail d'exécution |
| Budget | réservations par tâche (`#affordable`, `budget_reservations`), plafond mission, coût par rôle | **USD de modèle uniquement** ; la dépense Payworker est un **autre compte** (devise, plafond propre) |
| Journal d'audit | table `events` append-only, rédigée par `redact` | Oui |
| Permissions d'agent | `ROLES.tools` (allowlist explicite), `DENIED_TOOLS`, env en liste blanche `buildAgentEnv` (`src/util.js`), périmètre `scope` | Les agents Claude n'ont **aucun accès MCP** aujourd'hui (le runner ne passe pas de configuration MCP). Statu quo à conserver |
| Gestion de serveurs MCP | `server/advanced/mcp.ts` (Open Cortex) : enregistrement **désactivé par défaut**, `confirm:true`, projet approuvé, secrets dans le coffre mémoire hors argv/headers publics, `validateUrl`/`resolveTarget` (anti-SSRF) | Pour la **découverte interactive** dans Open Cortex ; ce n'est pas le canal d'exécution du CTO |
| Résultats | `reports`, `events`, `/report` (git, coûts, tests), `stale` + cache côté Open Cortex | Modèle oui ; schéma de résultat humain à définir |

## 3. Analyse par thème
**3.1 Délégation de missions humaines.** Rien n'existe : le CTO ne sait déléguer qu'à 4 rôles Claude. Il faut un type de tâche **non-LLM** `human`, exécuté par le code de l'orchestrateur (pas par un agent), derrière un port étroit :
`HumanWorkPort { create(idempotencyKey, brief, budgetCap) → handle ; status(handle) ; result(handle) ; cancel(handle) }`, avec deux implémentations : double de contrat (tests, zéro coût) et adaptateur MCP AIWORKPAY (H : outils équivalents à ces 4 opérations).

**3.2 Approbations.** Toute création de mission humaine est irréversible en pratique (engagement financier, exposition de données à un tiers). Recommandation : nouvelle approbation `human_delegation` (fondateur, **par mission humaine**, avec le brief exact, le plafond de dépense et les données exposées affichés), distincte de `mission`/`architecture`/`completion`. Jamais d'auto-approbation, jamais de réutilisation d'une approbation pour un autre brief (lier l'approbation au hash du brief). Le résultat d'un Payworker passe aussi par une vérification (CTO + QA/Sécurité) avant d'être accepté.

**3.3 Permissions.** (a) Le jeton MCP AIWORKPAY vit **uniquement dans l'environnement du processus CTO** (comme `CTO_ADMIN_TOKEN`), jamais dans un agent, un prompt, un rapport, ni côté navigateur ; Open Cortex ne le détient pas. (b) Scopes minimaux côté AIWORKPAY (H : créer/lire/annuler **ses propres** missions, rien d'autre). (c) Les agents Claude restent sans accès MCP ; seule l'orchestration appelle le port. (d) Minimisation des données : le brief envoyé à un humain est **construit et rédigé par le CTO** à partir de champs autorisés, avec le scan de secrets existant ; jamais de code source brut sans approbation explicite. (e) Séparation stricte dev/métier : aucun accès croisé aux données de la workforce AiWorkPay.

**3.4 Idempotence.** Clé d'idempotence = `${missionId}:${taskId}:${briefHash}` transmise à AIWORKPAY (H : champ de clé ou recherche par référence). Enregistrer le handle **avant** l'appel sortant (même schéma que le pont Open Cortex), réconcilier par recherche de référence après coupure. Si AIWORKPAY ne supporte ni clé ni recherche : **blocage de conception** (risque de double paiement) → traiter comme prérequis (Q4).

**3.5 Récupération des résultats.** (H) polling et/ou webhook. Préférer le polling signé côté CTO (aucun port entrant, cohérent avec le périmètre loopback). Les résultats sont des **données non fiables** (injection, contenu malveillant, fichiers) : jamais exécutés ni traités comme instructions ; validation de schéma, taille et type, scan de secrets, puis QA/Sécurité comme pour du code d'agent. Délais, expiration, rejet et re-délégation doivent être des états explicites, avec escalade au fondateur.

## 4. Architecture recommandée
Option retenue **B** : le CTO héberge l'adaptateur derrière le port `HumanWorkPort` ; Open Cortex affiche et fait approuver (flux existant Open Cortex → CTO inchangé).
| Option | Avis |
|---|---|
| A. Agents Claude appellent le MCP | **Rejetée** : un agent soumis à l'injection de prompt pourrait engager de l'argent ou exfiltrer des données |
| **B. Orchestrateur CTO appelle le MCP via un port** | **Retenue** : surface minimale, secrets côté serveur, approbation et audit déjà en place |
| C. Open Cortex appelle le MCP pour le CTO | Rejetée : inverse la direction Open Cortex → CTO, disperse les secrets et le budget |
Le gestionnaire MCP d'Open Cortex peut servir **séparément** à explorer le serveur (désactivé par défaut, connexion explicite) lors de la phase 1.

## 5. Modèle de menaces (résumé)
| Menace | Parade prévue |
|---|---|
| Double création/paiement après coupure | clé d'idempotence + handle persistant avant envoi + réconciliation |
| Injection via le résultat d'un Payworker | données non fiables, schéma strict, QA/Sécurité, jamais exécuté |
| Fuite de code/secrets vers un humain | brief rédigé par le CTO, scan de secrets, approbation `human_delegation` avec aperçu |
| Dépense non maîtrisée | plafond propre par mission humaine et global, réservation avant envoi, arrêt si dépassement |
| Jeton MCP exposé | env serveur CTO uniquement, rédaction, jamais dans un agent/UI |
| Approbation détournée/rejouée | approbation liée au hash du brief, état frais exigé, audit append-only |
| Mission humaine orpheline | expiration, annulation, escalade ; reprise sans doublon |

## 6. Feuille de route progressive
Règle : chaque phase est une PR distincte, validée par le fondateur avant la suivante ; les phases 0 à 5 ne coûtent **rien** (aucun appel payant, aucune mission réelle).

| Phase | Contenu | Critères d'acceptation | Tests |
|---|---|---|---|
| **0. Décisions et prérequis** | Obtenir le contrat MCP AIWORKPAY (outils, schémas, auth, idempotence, webhooks, erreurs), un **tenant sandbox sans valeur monétaire**, la politique de données, les plafonds ; trancher Q1-Q7 | Contrat versionné dans le dépôt ; sandbox confirmé sans débit ; réponses Q1-Q7 écrites | Revue documentaire |
| **1. Découverte lecture seule** | Enregistrer le serveur dans le gestionnaire MCP d'Open Cortex (désactivé), connexion explicite, **liste des outils uniquement**, aucune mission | Catalogue des outils capturé ; aucune écriture côté AIWORKPAY ; jeton absent des journaux | Test : zéro appel mutant ; test de non-fuite du secret |
| **2. Port + double de contrat** | `HumanWorkPort`, `FakeHumanWork`, type de tâche `human`, états (`delegation_pending_approval`, `awaiting_worker`, `result_received`, `verified`, `rejected`, `expired`, `cancelled`), persistance | Aucun adaptateur réel ; les machines à états passent tous les cas | Unitaires + interruption/reprise sans doublon (comme la certification du 24) |
| **3. Approbation `human_delegation`** | Nouveau `kind`, aperçu du brief/plafond/données, lien au hash du brief, carte dans la vue Équipe IA | Aucune création possible sans approbation fraîche ; modification du brief ⇒ ré-approbation ; refus ⇒ annulation propre | Tests de pont (état périmé, rejeu, mauvais hash, `confirm` absent) + test de vue |
| **4. Adaptateur MCP en sandbox** | Implémentation du port contre le tenant sandbox, plafond de dépense à 0 ou sandbox, clé d'idempotence, annulation | Création/lecture/annulation réelles côté sandbox ; rejeu = même handle ; coupure après envoi réconciliée | Contrat enregistré rejoué ; test kill -9 pendant `create` ; test de double envoi |
| **5. Résultats et vérification** | Ingestion (polling signé), schéma strict, taille/type, scan de secrets, QA/Sécurité sur le résultat, rejet/re-délégation bornés | Un résultat piégé (injection, fichier hors schéma, secret) est rejeté et journalisé ; jamais exécuté | Jeux de résultats hostiles ; expiration et escalade |
| **6. Budget et observabilité** | Compte de dépense Payworker séparé, réservation avant envoi, plafond mission/global, coûts dans le rapport et l'UI | Dépassement ⇒ blocage ; coûts visibles par mission humaine | Tests de plafond, d'arrondi, d'interruption |
| **7. Pilote réel limité** | Une mission humaine réelle, plafond minimal fixé par le fondateur, approbations réelles | Cycle complet vérifié, preuves archivées, aucune action hors approbation | Mission pilote documentée comme celles du 22 et 24 novembre |

Prérequis transversaux : conserver le déploiement local (loopback), aucune exposition publique ; aucun changement du chemin validé Open Cortex → CTO → 4 agents ; les 173 + 117 tests restent verts à chaque phase.

## 7. Questions à trancher avant la phase 0
- **Q1** Que signifie exactement « boucle humaine » (délégation à des Payworkers, supervision, les deux) et dans quel ordre ?
- **Q2** Où est la spécification du MCP AIWORKPAY (outils, schémas d'entrée/sortie, erreurs, limites) et quelle est sa version ?
- **Q3** Authentification : jeton statique, OAuth, rotation ? Scopes disponibles ?
- **Q4** Idempotence : le serveur accepte-t-il une clé fournie par le client, ou une recherche par référence ? (bloquant)
- **Q5** Résultats : polling, webhook, ou les deux ? Format et pièces jointes ?
- **Q6** Existe-t-il un environnement sandbox sans débit ? Qui paie en phase 7 et quel plafond ?
- **Q7** Quelles données de développement peuvent être montrées à un humain (RGPD, confidentialité, contrat avec les Payworkers) ?

## 8. Risques et décisions à votre charge
Engagement financier et exposition de données = **décisions fondateur** (charte `SECURITY.md`). Dépendance forte à la qualité du contrat AIWORKPAY (idempotence notamment). Latence humaine (heures/jours) incompatible avec les baux d'exécution actuels : prévoir des états d'attente persistants (phase 2).

## 9. Non-périmètre confirmé
Aucun MCP intégré ni connecté, aucune boucle humaine développée, aucun Payworker contacté, aucune PR de code, aucune fusion, aucun déploiement, aucune dépense, aucune restauration Supabase.
