# Audit initial P0 — état après lecture de la spécification finale

## Périmètre inspecté

L’audit a porté sur `server/runner.ts`, `security/seccomp-runner.json`, `scripts/runner-preflight.sh`, `scripts/runner-escape-suite.sh`, `docs/runner-p0-validation.md`, `lab/P0-VALIDATION-REPORT.md`, `tests/runner.test.ts` et les points d’intégration dans `server/context.ts`, `server/index.ts` et `server/advanced/process.ts`.

## Fonctionnel et déjà présent

Le backend possède un chemin Podman/crun rootless, une image obligatoirement référencée par digest, un profil seccomp versionné, un réseau `none`, des namespaces privés, `no-new-privileges`, la suppression des capacités et des bornes CPU/mémoire/PID/sortie. Les commandes de projets non fiables ne retombent pas sur l’hôte : elles sont refusées si le runner certifié n’est pas disponible.

L’API de capacité est locale et ne renvoie pas de secrets. Le profil seccomp est copié dans le build serveur. Les tests unitaires couvrent maintenant les mappings incomplets, invalides et valides ainsi que le refus fermé.

## Écarts critiques constatés

La validation rootless réelle n’est pas possible dans le sandbox actuel : la user namespace expose uniquement `0 -> 1000 (1)`, malgré la présence de fichiers subuid/subgid. Le namespace cgroup privé échoue également dans cet environnement imbriqué. Ces écarts sont correctement traités comme FAIL ou NOT RUN.

Le quota actuel du workspace est insuffisant pour une certification : le code bind-monte un workspace temporaire mais ne prouve pas une limite de stockage sur l’ensemble de ce workspace. Le quota `/tmp` ne doit pas être présenté comme une limite du workspace complet ; le runner laisse donc la capacité non certifiée.

L’attestation de capacité est descriptive et l’attestation d’exécution est refusée tant qu’elle n’est pas liée au conteneur réel. L’intégration complète d’OpenCode, Git, MCP et des agents parallèles dans des runners distincts reste bloquée pour les projets non fiables.

Le registre durable, les leases/heartbeats et la récupération complète d’orphelins restent à compléter avant la certification P1. La copie du workspace détecte les mutations concurrentes par snapshots et refuse les objets dangereux ; une copie fondée sur des descripteurs Linux (`openat2` ou équivalent) reste à valider sur la VM cible.

## Conclusion d’audit

Le code satisfait le principe de refus fermé et ne doit pas activer les dépôts non fiables dans l’environnement actuel. La certification P0 ne peut pas être accordée dans le sandbox. La validation suivante doit utiliser le script d’installation sur une VM indépendante, exécuter `runner-preflight.sh`, puis `validate-runner.sh`. Tout résultat non exécuté doit rester `NOT RUN`.
