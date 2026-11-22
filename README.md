# Open Cortex Coder

Environnement de programmation agentique **local-first**, fondé sur OpenCode **2.2.7**, avec interface React/Monaco et enveloppe Electron. Projet indépendant, non développé par l'équipe OpenCode et non affilié à Anomaly.

> Version 0.1.0 : base fonctionnelle en développement, pas une parité complète avec Codex, Claude Code ou Jules. Les intégrations externes et les limites connues sont documentées; la présence d'une option d'interface ne signifie pas qu'un fournisseur distant a été testé.

## Architecture et confidentialité

Le moteur OpenCode et le connecteur s'exécutent sur l'appareil de l'utilisateur et écoutent sur `127.0.0.1`. Les projets, la mémoire, les credentials et les outils restent locaux. L'application ne requiert pas de backend éditeur. Les clés fournisseur sont détenues par le connecteur local et transmises au fournisseur choisi lors des appels de modèle; elles ne sont pas intégrées au dépôt.

Les permissions de l'agent et les worktrees **ne constituent pas un sandbox OS**. N'exécutez que des projets de confiance; les commandes disposent des droits du compte utilisateur. Le pairing facultatif depuis une origine HTTPS est fermé par défaut, doit être activé localement et n'est pas certifié sur de vrais navigateurs.

L'espace **Équipe IA** pilote le CTO IA d'AiWorkPay (missions, approbations, preuves) : voir [docs/equipe-ia-cto.md](docs/equipe-ia-cto.md).

Consulter les guides de [l'architecture](docs/architecture.md), de [l'utilisation](docs/utilisation.md), de [la sécurité](docs/securite.md), du [pairing HTTPS vers loopback](docs/pairing-https-loopback.md) et le [contrat API du connecteur](docs/contrat-connecteur.md). La licence MIT d'OpenCode est conservée dans [`docs/licenses/OPENCODE-MIT.txt`](docs/licenses/OPENCODE-MIT.txt).

## Prérequis

- Node.js 22.16 ou plus récent (Node 22 ou 24 recommandé)
- pnpm 11.25.0
- Git
- Facultatif : Ollama et un modèle local compatible outils pour les essais agentiques sans API distante

## Installer et lancer le Web local

```bash
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Le connecteur imprime une URL locale `http://127.0.0.1:4000/#token=…`. Le port se change avec `CORTEX_PORT`. Le serveur reste lié à `127.0.0.1`.

Les clés BYOK se saisissent dans un profil de l’interface locale. Elles restent en mémoire du connecteur et ne vont pas dans le dépôt. Sans clé et sans endpoint loopback joignable, une mission Agent reste `BLOCKED` : aucun correctif de remplacement n’est écrit.

Le runner externe est un second processus. Même jeton des deux côtés, 16 caractères au minimum :

```bash
export CORTEX_RUNNER_TOKEN='remplacer-par-un-secret-local-long'
export CORTEX_RUNNER_HOST=127.0.0.1
export CORTEX_RUNNER_PORT=8791
export CORTEX_RUNNER_DATA="$PWD/.cortex/runner"
export CORTEX_RUNNER_URL="http://127.0.0.1:${CORTEX_RUNNER_PORT}"
pnpm exec tsx server/runner/main.ts
```

Le détail du protocole est dans [docs/runner-externe.md](docs/runner-externe.md). Un namespace peut produire `PASS`. `CERTIFIED` exige Docker réellement exécuté.

## Desktop Linux

```bash
pnpm desktop
# Construire le paquet Debian et l'archive portable pour la machine de build
pnpm package:desktop
```

Le build Linux ARM64 a été testé dans l'environnement de développement; les binaires générés ne sont ni signés ni inclus dans ce dépôt. Les builds x86_64, macOS et Windows, la notarisation et la signature n'ont pas été validés. Les clés durables restent désactivées si le coffre OS ne fournit pas un backend chiffré sûr.

## Développement et tests

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm dev
```

La commande `pnpm test` est le critère de la suite. Le décompte de 86 tests ne décrit plus cette livraison. `pnpm test:engine` requiert Ollama et un modèle local ; il ne prouve pas qu’un compte API commercial est disponible.

## Modèles, MCP et automatisations

Les profils de modèles acceptent des credentials fournis par l'utilisateur. Aucun appel payant ni test réel des comptes Z.ai, OpenAI, Anthropic, Gemini ou autres n'est garanti. Les intégrations MCP distantes, GitHub OAuth/webhooks, les événements GitHub et l'exécution simultanée de plusieurs générations restent partiels ou non validés; voir les limites dans le guide de [sécurité](docs/securite.md) et le [manuel](docs/utilisation.md).

Le connecteur ajoute un plan de mission local (preuve de test obligatoire, conflits de fichiers, brief de reprise sans appel modèle, correctif manuel borné, et mode Agent OpenCode quand un modèle est vraiment joignable). L’agent peut corriger plusieurs fichiers du périmètre, sur une branche autre que `main`, et préparer une pull request sans la publier. Sans modèle, la mission reste BLOCKED. La publication Git reste explicite : branche `cortex/…`, commit limité, push non forcé, pull request via `gh` sans fusion. `remoteCertified` reste faux tant qu’une opération distante réelle n’est pas prouvée. L’orchestrateur reprend les étapes déjà validées et s’arrête avant toute publication. Le runtime multi-agents ajoute une mémoire SQLite, des tâches indépendantes en parallèle et les mêmes permissions Git séparées. La pause ne coupe pas un appel modèle déjà lancé. L’exécution peut exiger Docker ; sinon elle reste `BLOCKED_SANDBOX` ou, sur demande explicite, `PASSED_LOCAL`. Un contrat de mission scellé refuse un changement d’objectif issu d’un résumé. Le runner externe loopback signe ses preuves : un namespace isolé peut être PASS, jamais CERTIFIED, et Docker absent reste bloqué.

## Licence

Open Cortex Coder est distribué sous licence MIT; voir [`LICENSE`](LICENSE). OpenCode et les autres dépendances restent soumis à leurs licences respectives.
