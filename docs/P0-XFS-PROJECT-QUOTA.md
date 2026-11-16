# Quota global workspace

Le quota cible est un project quota sur un filesystem XFS dédié monté avec `prjquota`. Il doit couvrir tout le workspace, pas seulement `/tmp`, un fichier ou la couche de stockage du conteneur.

`03-prepare-xfs.sh` et `04-configure-project-quota.sh` sont administratifs et nécessitent un périphérique dédié. `08-run-storage-tests.sh` écrit progressivement plusieurs données et exige un dépassement observable. Une configuration seule ou `storage-opt size` ne suffit pas.

Sans volume XFS dédié et preuve côté hôte et conteneur, le résultat reste `workspaceQuotaProof=NOT RUN` et `storage=fail`.
