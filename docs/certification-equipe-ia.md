# Mission de certification : planifier, coder, détecter un défaut, corriger, tester, préparer la livraison

Exécutée le 2026-11-22 sur un dépôt temporaire indépendant (`/tmp/cert/repo`, `main` = `5cda445`). Vrais agents Claude (`claude-sonnet-5-5`) lancés par le vrai CTO.
Tout le pilotage passe par **l'interface Équipe IA dans Chromium** (`scripts/certify-team-ui.cjs`) : enregistrement du CTO, création de mission, trois approbations.
Les deux services sont démarrés par `scripts/team-up.sh` ; `node` n'est **pas** dans `/usr/bin` (le jail le monte seul, en lecture seule).

Objectif : `wrapText(text, width)` ([énoncé](pilot/certification-objective.txt)). Tests d'acceptation du propriétaire invisibles des agents ([fichier](pilot/certification-acceptance.test.js.txt)),
satisfiables : vérifiés au préalable avec une implémentation de référence écrite à la main (9/9). Ils poussent volontairement sur un cas limite que l'énoncé ne détaille pas (largeur en caractères visibles : un emoji = 1).

| # | Étape | Observé |
|---|---|---|
| 1 | Création depuis l'interface | mission transmise (budget 2,5 USD, périmètre `src test`) |
| 2 | Architecte | plan accepté, 0,119 USD ; il raisonne en `.length` (UTF-16) |
| 3 | Approbations (dépôt temporaire) | lancement, architecture, puis livraison, toutes via l'interface |
| 4 | Backend, essai 1 | écrit `src/wrap.js` + tests (0,131 USD) ; ses propres tests passent (8/8) |
| 5-6 | Tests du CTO, **défaut réel détecté** | acceptation 8/9 : l'emoji est coupé en deux (`'😀\ud83d\n\ude00😀\n😀'` au lieu de `'😀😀😀\n😀'`) → `correction_requested` |
| 7 | **Correction autonome** | le backend identifie la cause (longueur UTF-16), passe à `Array.from` (points de code), 0,129 USD |
| 8 | Tests relancés par le CTO | projet 9/9, acceptation 9/9 |
| 9 | QA et Sécurité | QA `pass` (1 constat non bloquant), Sécurité `pass` (0 constat) |
| 10 | PR | branche `cto/4b3d79f3/backend-441a8bc5`, commit `4bcb25c`, rapport de PR généré (non poussée, non fusionnée) |
| 11 | Redémarrage des deux services | mission, coûts par agent, correction, preuves, enregistrement du superviseur retrouvés ; aucun doublon |
| 12 | Vérification indépendante | worktree détaché : projet 9/9, acceptation 9/9 ; `main` inchangé ; aucun fichier hors `src`/`test` ; aucun secret ; mission `completed`, worktrees nettoyés |

**Coût réel de la mission : 0,603 USD** (architecte 0,119 ; backend 0,260 sur 2 essais ; QA 0,113 ; sécurité 0,110), plafond 2,5 USD.
Le défaut n'a pas été scripté : l'agent l'a produit, le CTO l'a détecté avec des tests qu'il exécute lui-même, l'agent l'a corrigé.

## Défauts trouvés et corrigés pendant la certification
- `scripts/team-up.sh` : le PID enregistré était celui d'un sous-shell et le script ne rendait pas la main.
- Interface : attributs HTML `pattern` invalides en mode `v` de Chromium (tiret non échappé), donc validation du formulaire ignorée.
- Formulaire : aucun champ pour les tests d'acceptation (ajouté).
- Jail du runner externe : exigeait `node` dans `/usr/bin` ; il monte maintenant uniquement le binaire Node courant, en lecture seule.

## Limites
Isolation = namespaces bubblewrap, pas Docker. Une seule correction réelle observée (la boucle de correction en réel : 1 occurrence). Approbations simulées uniquement sur ce dépôt temporaire.
