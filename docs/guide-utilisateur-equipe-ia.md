# Guide utilisateur — Open Cortex Code + CTO IA

Open Cortex Code est l'interface ; le CTO IA (processus séparé) planifie, délègue à ses 4 agents (Architecte, Backend, QA, Sécurité), exécute les tests dans un bac à sable et prépare une branche Git locale. Rien n'est poussé, fusionné ni déployé sans vous.

## 1. Prérequis (Linux)
Node.js 22+, pnpm 11 (`corepack prepare pnpm@11.25.0 --activate`), Git, CLI `claude` authentifié, bubblewrap.

## 2. Installation
```bash
git clone https://github.com/AiWorkPay-SASU/CTO-AI-AIWORKPAY.git
git clone https://github.com/cortexAI-2025/open-cortex-code.git     # récupère main
(cd CTO-AI-AIWORKPAY && npm run setup:linux)                         # installe bubblewrap si absent, puis vérifie
(cd open-cortex-code && pnpm install --frozen-lockfile && pnpm build)
```
`npm run doctor` (dans le CTO) affiche l'état réel du runtime : `READY` ou `BLOCKED` (code de sortie 1, avec la cause). `BLOCKED` = aucune mission ne démarre, rien n'est simulé.

## 3. Démarrage
```bash
cd open-cortex-code
CTO_DIR=/chemin/CTO-AI-AIWORKPAY scripts/team-up.sh /chemin/absolu/du/depot-a-modifier
```
Le script lance le CTO puis Open Cortex, attend leur santé et affiche l'URL locale de pairing (`http://127.0.0.1:4000/#token=…`, ne pas la partager). Configuration persistante : `~/.opencortex/team.env` (mode 600, jeton généré localement). Données : `~/.opencortex/run/`.
Arrêt : `kill $(cat ~/.opencortex/run/cto.pid ~/.opencortex/run/occ.pid)`.
Le dépôt passé en argument doit être le projet ouvert dans Open Cortex (sinon `CTO_REPO_MISMATCH`).

## 4. Utilisation
1. Ouvrez l'URL de pairing. **Projets** : ouvrez le dépôt, marquez-le approuvé.
2. **Équipe IA** → « Enregistrer le CTO IA » (une fois). Vérifiez : connexion `CONNECTÉ`, isolation `READY`, 4 agents disponibles.
3. **Nouvelle mission** : dépôt `owner/repo` (libellé de la PR), objectif, critères, périmètre d'écriture (`src test`), budget plafond, tests d'acceptation facultatifs (le CTO les exécute lui-même, les agents ne les voient pas).
4. Approuvez à chaque étape sensible : lancement → plan de l'architecte (lisez-le) → livraison finale. Chaque décision demande une confirmation.
5. Suivez tâches, coûts par agent, tests, revues QA/Sécurité, événements, corrections, blocages.
6. Résultat : branche locale `cto/…`, commit, fichiers, rapport de PR prêt. La publication (push, PR GitHub) et la fusion restent vos décisions.
7. « Reprendre » relance une mission interrompue sans doublon ; « Annuler » l'arrête proprement.

## 5. Dépannage
| Symptôme | Cause / action |
|---|---|
| `BLOCKED : bubblewrap_isolation` | `npm run setup:linux` |
| `CTO_REPO_MISMATCH` | relancer `team-up.sh` avec le chemin du projet ouvert |
| `INJOIGNABLE` / état « périmé » | CTO arrêté : relancer `team-up.sh`, puis « Reprendre » |
| `JETON REFUSÉ` | `CORTEX_CTO_TOKEN` ≠ `CTO_ADMIN_TOKEN` : utiliser `team-up.sh` |
| Coût | plafond par mission ; une exécution interrompue est comptée à son plafond (estimation) |

Isolation = namespaces bubblewrap (pas Docker). Ne pas exposer les services hors loopback.
