# Exécution sécurisée

Phase 6 ajoute une couche devant OpenCode et le runtime multi-agents. Elle ne les remplace pas.

## Adaptateurs

- `docker` : conteneur non privilégié, capabilities retirées, réseau coupé par défaut, système de fichiers en lecture seule, limites mémoire, CPU, processus et durée. Aucun socket Docker et aucun secret monté. Pas de téléchargement d’image.
- `local` : processus du connecteur, explicitement non isolé. Utilisé seulement si l’appel demande `isolation: "local"`.
- L’interface reste un adaptateur : une future sandbox se branche sans changer la politique.

`CERTIFIED` exige une sonde Docker réelle (`docker info` et image locale) et un exit 0. Un double de test, un mock ou un succès local donnent `BLOCKED` ou `PASSED_LOCAL`. Si l’isolation est exigée et Docker est absent, le verdict est `BLOCKED_SANDBOX`. Le runtime local n’est alors pas lancé.

## Politique

La politique serveur décide des commandes, chemins, liens symboliques, secrets, branches protégées, push forcé et permissions `allowCommit`, `allowPush`, `allowPullRequest`. Ces trois permissions restent indépendantes. Les refus sont journalisés.

## Reprise

Les baux, heartbeats et checkpoints sont dans SQLite. Un bail expiré devient `abandoned` au redémarrage. Une tâche `passed` n’est pas relancée sans invalidation. Les effets externes ont une clé d’idempotence, mais `exactlyOnce` reste faux : si l’accusé est inconnu, l’effet n’est pas rejoué et n’est pas déclaré réussi.

## Fournisseur

Timeouts, erreurs 429 et 5xx, circuit breaker, concurrence et budget de jetons sont appliqués avant un appel OpenCode lorsqu’un budget de mission existe. Sans budget, le comportement des phases précédentes est inchangé. Un changement de fournisseur exige `allowProviderSwitch`. Les clés ne sont pas écrites. Aucun coût monétaire n’est inventé.

## Certification de projets

Les scénarios TypeScript/Node, React, Next.js, Python et Android sont décrits par le plan. Un scénario non exécuté reste `NOT_RUN`, `SKIPPED` ou `BLOCKED`. Il n’est jamais marqué réussi par un test simulé. Le résultat réellement mesuré est dans [certification-phase6.md](certification-phase6.md).

