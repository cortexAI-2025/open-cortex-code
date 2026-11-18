# Kit VM Linux dédiée P0

Ce kit prépare et valide le runner rootless dans une VM Linux dédiée.

Les scripts `03` et `04` sont administratifs et doivent recevoir un périphérique dédié. Les scripts `05` à `11` sont exécutés depuis le compte utilisateur rootless. Le script seccomp laisse explicitement la preuve du profil chargé à `NOT RUN` si aucune mesure fiable n'est disponible.

Exemple :

```bash
export P0_EVIDENCE_DIR="$PWD/lab/p0-vm/evidence"
bash lab/p0-vm/00-check-host.sh
bash lab/p0-vm/01-install-dependencies.sh
# reconnecter la session
bash lab/p0-vm/02-configure-rootless.sh
bash lab/p0-vm/05-verify-runtime.sh
# préparation administrative avec P0_XFS_DEVICE et P0_XFS_MOUNT
```

Ne jamais utiliser le sandbox imbriqué courant comme preuve de VM dédiée. Ne jamais lancer de dépôt non fiable avant certification indépendante.
