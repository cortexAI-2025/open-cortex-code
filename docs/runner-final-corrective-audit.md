

## Correctif final après audit indépendant

L’exécution utilise maintenant un seul conteneur : Podman le crée, le superviseur inspecte sa configuration effective, puis le même identifiant de conteneur est démarré avec la sonde et la commande. L’attestation est donc liée au `runnerId`, au nonce et au conteneur réellement exécuté. Le digest d’image est contrôlé côté hôte par `podman image inspect`, tandis que les propriétés d’isolation sont contrôlées depuis `podman inspect` et depuis le processus de la sonde.

La copie du workspace passe par `scripts/copy-workspace-secure.py`. Ce helper utilise `openat2` avec `RESOLVE_BENEATH`, `RESOLVE_NO_SYMLINKS`, `RESOLVE_NO_MAGICLINKS` et `RESOLVE_NO_XDEV`, ouvre les objets sans suivi de lien, vérifie `fstat`, refuse les fichiers spéciaux et hardlinks et compare l’identité et la taille après lecture. Toute indisponibilité d’openat2 provoque un refus.

La suite d’évasion exige maintenant un motif de preuve observable correspondant à chaque refus attendu. Un code retour non nul sans preuve attendue est classé `FAIL`, pas `PASS`. Les tests restent bornés et le test disque est limité à 512 MiB. Les outils absents restent `NOT RUN`.

Le quota workspace complet n’est toujours pas démontré. `storage=fail` interdit toujours `CERTIFIED`.
