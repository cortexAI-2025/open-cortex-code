# Intégrité de mission

Le contrat scellé est la source d’autorité. Un résumé de conversation, une mémoire ou une réponse d’outil ne change ni l’objectif, ni le dépôt, ni la branche, ni les permissions.

L’empreinte SHA-256 couvre l’instruction originale, l’objectif, le dépôt, la branche, le périmètre, les permissions, les critères, la date et la version. Elle détecte une altération stockée. Elle ne décide pas si un nouvel objectif est acceptable : ce choix exige `source: "user"` et `confirm: true`. L’instruction originale reste conservée, la version augmente.

Avant une écriture, le serveur compare de façon exacte le dépôt réel, la branche, les chemins et les permissions. Une différence d’objectif, après normalisation Unicode et espaces, bloque l’opération. Il n’y a pas de score de similarité.

`POST /api/projects/:id/missions/:missionId/contract` scelle. `POST …/contract/amend` amende. `POST …/contract/check` journalise un refus sans écrire le projet.
