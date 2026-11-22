# Certification Phase 6.1

Date : 2026-11-22. Branche `cortex/phase6-1-runtime-certification`. Aucun nouvel appel modèle. Docker absent. Aucun statut `CERTIFIED`.

| Scénario | Statut | Preuve |
| --- | --- | --- |
| Intégrité de mission | PASSED_UNIT | Résumé falsifié, autre application, dépôt, branche, permission, injection d’outil, redémarrage SQLite, mutation agent, amendement utilisateur. Écriture bloquée avant le fichier. |
| Reprise après crash | PASSED_LOCAL | Processus `tsx` arrêté par SIGKILL, base rouverte, étape `analyze` non rejouée, étape `edit` reprise une fois, effet externe déjà acquitté non rejoué. `exactlyOnce` reste faux. |
| Fournisseur | PASSED_UNIT | 429, 5xx, timeout, retry borné et circuit déjà couverts par simulation. Pas d’appel xAI. |
| TypeScript / Node | NOT_TESTED | `fixtures/certification/node-tax` reste rouge (exit 1). Correctif modèle non relancé. |
| React | BLOCKED | Fixture présente, aucun lanceur isolé, aucune installation. |
| Next.js | BLOCKED | Next absent. |
| Python | NOT_TESTED | `python3 -m unittest` du fixture reste non vert. Correctif modèle non lancé. |
| Android Gradle | BLOCKED | Projet minimal sans Gradle ni SDK. Indépendant de SimpleTools. |
| Sandbox Docker | BLOCKED | `scripts/certify-docker.ts` sonde `docker info`, n’exécute pas le runtime local, ne télécharge pas d’image, et ne peut pas produire `CERTIFIED`. |

Le runner Docker documenté exige un binaire Docker, l’image locale `node:22-alpine`, un conteneur non privilégié, capabilities retirées, réseau `none` par défaut, et aucun montage du socket.
