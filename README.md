# Open Cortex Coder

Environnement de programmation agentique **local-first**, fondé sur OpenCode **2.2.7**, avec interface React/Monaco et enveloppe Electron. Projet indépendant, non développé par l'équipe OpenCode et non affilié à Anomaly.

> Version 0.1.0 : base fonctionnelle en développement, pas une parité complète avec Codex, Claude Code ou Jules. Les intégrations externes et les limites connues sont documentées; la présence d'une option d'interface ne signifie pas qu'un fournisseur distant a été testé.

## Architecture et confidentialité

Le moteur OpenCode et le connecteur s'exécutent sur l'appareil de l'utilisateur et écoutent sur `127.0.0.1`. Les projets, la mémoire, les credentials et les outils restent locaux. L'application ne requiert pas de backend éditeur. Les clés fournisseur sont détenues par le connecteur local et transmises au fournisseur choisi lors des appels de modèle; elles ne sont pas intégrées au dépôt.

Les permissions de l'agent et les worktrees **ne constituent pas un sandbox OS**. N'exécutez que des projets de confiance; les commandes disposent des droits du compte utilisateur. Le pairing facultatif depuis une origine HTTPS est fermé par défaut, doit être activé localement et n'est pas certifié sur de vrais navigateurs.

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

Ouvrez l'URL locale d'association imprimée par le connecteur. Gardez le token local confidentiel et ne partagez pas le lien. Le serveur reste lié à `127.0.0.1`; ne l'exposez pas sur le réseau.

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

La suite comporte 86 tests réussis dans la validation rapportée pour la version 0.1.0. Le test moteur peut être lancé avec `pnpm test:engine`; il requiert Ollama et utilise un modèle local spécifié dans le script. Les tests de génération locale ne prouvent pas que les comptes API commerciaux sont disponibles.

## Modèles, MCP et automatisations

Les profils de modèles acceptent des credentials fournis par l'utilisateur. Aucun appel payant ni test réel des comptes Z.ai, OpenAI, Anthropic, Gemini ou autres n'est garanti. Les intégrations MCP distantes, GitHub OAuth/webhooks, les événements GitHub et l'exécution simultanée de plusieurs générations restent partiels ou non validés; voir les limites dans le guide de [sécurité](docs/securite.md) et le [manuel](docs/utilisation.md).

## Licence

Open Cortex Coder est distribué sous licence MIT; voir [`LICENSE`](LICENSE). OpenCode et les autres dépendances restent soumis à leurs licences respectives.
