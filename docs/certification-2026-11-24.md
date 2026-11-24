# Certification finale — Open Cortex Code + CTO IA (2026-11-24)

Références : Open Cortex `52f318a` · CTO `faba557` (clones neufs, branche `main`). Aucun commit, aucune PR, aucune modification de dépôt ni de `gh-pages` pendant cette certification. Aucun appel modèle payant.

| # | Objectif | Résultat |
|---|---|---|
| 1 | `main` branche par défaut | **PASS** : les deux dépôts (corrigé depuis la dernière vérification) |
| 2 | Clone standard | **PASS** : `git clone` → `main` (`52f318a`, `faba557`) |
| 3 | GitHub Pages / `gh-pages` | `gh-pages` **préservée** (`accdca2`, inchangée). Fonctionnement du site **non vérifiable** : API Pages bloquée par le proxy, site injoignable depuis le conteneur |
| 4 | Installation reproductible | **PASS** : `setup:linux`, `doctor`, `pnpm install --frozen-lockfile`, `build` depuis clones neufs, sans `/usr/bin/node` |
| 5 | Tests | CTO **117** : 115 réussis, 0 échoué, 2 ignorés · Open Cortex **173/173** (tsc, build OK, test contre le vrai CTO inclus) |
| 6 | 2 tests Supabase | **BLOQUÉ** (voir ci-dessous) |
| 7 | Mission complète orchestrateur | **PASS** (agents scriptés, voir ci-dessous) |
| 8 | Persistance, reprise, isolation, erreurs | **PASS** |
| 9 | Guide utilisateur | [guide-utilisateur-equipe-ia.md](guide-utilisateur-equipe-ia.md) |

## Supabase — blocage précis
Les 2 tests sont ignorés tant que `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` ne sont pas définies (aucune des deux ne l'est). Le seul projet dédié existant (`cto-ai-multiagents`) est **en pause (`INACTIVE`)** : le restaurer change son état et peut engendrer des frais (non autorisé), et la clé `service_role` doit être fournie par vous en privé. La migration `001_init.sql` n'a jamais été appliquée. Les autres projets du compte sont sans rapport et n'ont pas été touchés. Pour lever : restaurer ce projet, appliquer la migration, exporter les 2 variables localement, relancer `npm test`, tester le refus `anon` (RLS).

## Mission complète (orchestrateur CTO réel, agents scriptés — pas de Claude)
Vrai orchestrateur, vrai Git, vraies approbations, vraie file durable à baux, vrais tests sous bubblewrap ; seules les réponses des 4 agents sont scriptées. Pilotée par l'interface Chromium (enregistrement, création, 3 approbations) via `scripts/certify-team-ui.cjs`.
- Backend essai 1 volontairement défectueux → **rejeté par les tests d'acceptation du CTO** → correction demandée.
- **Interruption** : `kill -9` du CTO pendant la correction. Open Cortex affiche `INJOIGNABLE`, agents « inconnus », mission **en cache marquée périmée** (`CTO_UNREACHABLE`).
- **Reprise** : redémarrage du CTO → `lease_expired` + `task_retry_scheduled` → la tâche est relancée **une seule fois** (journal des appels ([pilot/certification-24-appels-agents.log](pilot/certification-24-appels-agents.log)) : `backend retry` ×1, QA ×1, Sécurité ×1, aucun doublon). Le coût de l'exécution interrompue reste compté comme estimation (1,00 USD plafond).
- Résultat : QA `pass`, Sécurité `pass`, tests 2/2, acceptation 2/2, mission `completed`, branche `cto/e4c23e0e/backend-9e01556f` (`fdcb0660`), non poussée, non fusionnée ; `main` du dépôt de test inchangé.
- **Persistance** : redémarrage d'Open Cortex → mission, statuts, coûts, corrections, preuves Git, événements retrouvés, `stale=false` ; jeton CTO absent de toute réponse. Configuration `team.env` en mode 600.
- **Isolation** : la sonde `test/iso.test.js` (pas de `/etc`, pas de `/home`, aucun secret en variable d'environnement, pas de réseau) **passe** dans le bac à sable du CTO et **échoue hors sandbox** (contrôle témoin).
- **Erreur d'environnement** : sans bubblewrap (binaire renommé puis restauré), `doctor` et `/api/runtime` donnent `BLOCKED: bubblewrap_isolation: bwrap not found` (exit 1) ; aucune exécution simulée.
- La démonstration avec de vrais agents Claude (défaut réel détecté puis corrigé, 0,603 USD) date du 2026-11-22 sur les mêmes commits fonctionnels.

## Limitations résiduelles (synthèse ; détail ci-dessous)
Isolation = namespaces bubblewrap, **pas Docker** (non exécuté, aucune certification conteneur). Supabase jamais exécuté en réel (ci-dessus). Pages non vérifié. Authentification par jeton partagé (pas de comptes par utilisateur). Une seule correction autonome réelle par un vrai modèle observée. `setup:linux` couvre bubblewrap ; l'environnement cloud dédié a un script d'initialisation, non testé sur un conteneur neuf. Publication distante de PR et fusion restent manuelles. 7 PR anciennes restent ouvertes (non touchées), dont `feature/mcp-atlas-integration` (hors périmètre, non intégrée).

## Verdict
**Utilisation opérationnelle locale : GO.** **Production : NO-GO** (inchangé). Aucun MCP AIWORKPAY, Payworker ni Human-on-the-Loop intégré ; aucun déploiement ; aucun secret exposé.

## Limitations résiduelles — détail et conditions de levée
| Limitation | Détail | Pour la lever |
|---|---|---|
| **Supabase** | `SupabaseStore` n'a été testé que contre un faux serveur PostgREST (`testkit/fake-postgrest.js`). Les 2 tests « live » restent ignorés ; la migration `001_init.sql` n'a jamais été appliquée ; la politique RLS (refus `anon`) n'a jamais été éprouvée en réel. Le projet dédié est en pause : **ne pas le restaurer sans autorisation** (état et coût). | Autorisation de restaurer (ou créer) un projet dédié → appliquer la migration → exporter `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` localement (jamais dans un dépôt) → `npm test` + test de refus `anon`. |
| **GitHub Pages** | La branche `gh-pages` est intacte, mais le fonctionnement du site n'a pas pu être vérifié (API Pages et site inaccessibles depuis l'environnement d'exécution). | Vérifier l'URL publiée et la source Pages dans les réglages du dépôt. |
| **Authentification** | Deux jetons statiques (propriétaire / lecture seule) côté CTO ; jeton de pairing local côté Open Cortex ; pas de comptes par utilisateur, pas de rôles fins, pas de rotation automatique. Services liés à `127.0.0.1` uniquement, ne pas les exposer. | Authentification par utilisateur et TLS devant l'API avant tout hébergement (TASK-003 du CTO). |
| **Tests avec de vrais modèles** | Seules deux missions ont utilisé de vrais agents Claude (2026-11-22 : 0,581 USD et 0,603 USD), dont **une seule correction autonome** observée. La boucle de rework après revue, les échecs répétés et l'épuisement du budget ne sont couverts que par des agents scriptés. La certification du 2026-11-24 n'a utilisé aucun appel modèle. | Campagne de missions réelles variées sous plafond de budget validé, incluant un rework après revue et un blocage budgétaire. |
| **Isolation** | Namespaces bubblewrap (utilisateur, PID, réseau, montage, capacités retirées) ; ce n'est **pas** un conteneur Docker et ne doit jamais être présenté comme tel. | Chantier Docker distinct, non engagé. |
| **Environnement neuf** | `setup:linux` et le script d'initialisation de l'environnement cloud installent bubblewrap ; ce dernier n'a pas été exécuté sur un conteneur entièrement neuf. | Démarrer une session sur l'environnement dédié et lancer `npm run doctor`. |
| **Publication Git** | Le CTO prépare branche locale et rapport de PR ; push, PR distante et fusion restent manuels. | Volontaire. |
