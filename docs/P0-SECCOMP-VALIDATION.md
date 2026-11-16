# Validation seccomp P0

Podman/crun permettent d'appliquer un profil JSON et d'observer le mode seccomp dans `/proc/self/status`. Ces éléments prouvent que seccomp est actif et qu'un profil a été demandé, mais ne prouvent pas à eux seuls l'identité cryptographique du programme BPF effectivement chargé.

`containers/oci-seccomp-bpf-hook` peut tracer des appels système et générer un profil via eBPF, mais sa documentation indique un besoin de `CAP_SYS_ADMIN`. Il sert à préparer un profil de laboratoire, pas à fabriquer une preuve rootless du filtre chargé.

Le script `09-run-seccomp-tests.sh` conserve donc `loaded_profile_hash=NOT RUN`. Il est interdit de remplacer ce statut par le hash du fichier local ou par `Seccomp: 2`.
