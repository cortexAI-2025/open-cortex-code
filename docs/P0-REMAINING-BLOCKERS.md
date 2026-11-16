# Blocages P0 restants

1. **VM Linux dédiée absente.** Aucune VM non imbriquée et hors production n’a exécuté les preuves rootless, UID/GID et cgroups v2 privés. Le sandbox actuel ne constitue pas cette preuve.
2. **Quota global du workspace non démontré.** Il faut prouver un quota XFS `prjquota` appliqué à l’ensemble du workspace, y compris sous écritures concurrentes. Un quota `/tmp` ou une simple limite déclarative ne suffit pas.
3. **Filtre seccomp BPF effectivement chargé non mesuré.** Podman/crun peuvent montrer qu’un profil a été demandé et que seccomp est actif, mais ces faits ne prouvent pas l’identité du filtre chargé. Le hash du fichier local n’est pas une preuve du BPF actif.
4. **Suite indépendante d’évasion non exécutée sur VM dédiée.** Les tests locaux, unitaires ou synthétiques ne remplacent pas la suite complète sur la VM cible avec une preuve observable pour chaque mécanisme de refus.
5. **Signature protégée des preuves indisponible.** L’attestation actuelle marque la signature `UNAVAILABLE`; son manifeste SHA-256 détecte certains changements mais n’authentifie pas son origine. Aucun champ JSON déclarant `VERIFIED` ne peut se substituer à une vérification cryptographique par clé de confiance.
6. **Certification P0 ne peut pas être accordée dans l’environnement actuel.** L’orchestrateur de certification collecte maintenant les codes de sortie, isole les preuves dans un répertoire propre à chaque exécution et traite tout code non nul comme un échec ou un état non exécuté. Il n’effectue volontairement aucune transition vers `CERTIFIED` tant qu’un vérificateur cryptographique protégé n’existe pas et que toutes les preuves précédentes ne sont pas validées.

Ces blocages sont intentionnels : ils empêchent une certification artificielle. Le code reste en refus fermé tant que les preuves ne sont pas obtenues; aucune exécution de dépôt non fiable ne doit être activée entre-temps.
