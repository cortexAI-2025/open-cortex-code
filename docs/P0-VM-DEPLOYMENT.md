# Déploiement VM P0

La certification exige une VM Linux dédiée, non imbriquée et non utilisée en production. Les scripts de `lab/p0-vm/` séparent les opérations administratives des opérations rootless.

## Ordre

1. `00-check-host.sh` — contrôle non destructif.
2. `01-install-dependencies.sh` — installation via sudo.
3. Reconnexion de la session utilisateur.
4. `02-configure-rootless.sh` puis `05-verify-runtime.sh`.
5. `03-prepare-xfs.sh` avec un périphérique dédié explicitement défini.
6. `04-configure-project-quota.sh` avec un quota expérimental.
7. `06-build-runner-image.sh`.
8. `07-run-isolation-tests.sh`, `08-run-storage-tests.sh`, `09-run-seccomp-tests.sh`.
9. `10-generate-attestation.sh` puis `11-run-p0-certification.sh`.

La VM actuelle du sandbox n'est pas présentée comme VM dédiée. Toute étape indisponible produit `NOT RUN` ou `FAIL`.
