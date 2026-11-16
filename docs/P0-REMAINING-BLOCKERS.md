# Blocages P0 restants

1. Aucune VM Linux dédiée n'est attachée à cet environnement.
2. Le quota global workspace n'est pas expérimentalement démontré sur un XFS `prjquota` dédié.
3. Podman/crun n'exposent pas actuellement une mesure fiable de l'empreinte du filtre seccomp BPF effectivement chargé dans ce workflow rootless.
4. La suite d'évasion complète et indépendante n'est pas exécutée dans une VM dédiée.

Ces blocages sont intentionnels : ils empêchent une certification artificielle. Le code doit rester en refus fermé tant que les preuves ne sont pas obtenues.
