# Solution P0 concrète : GitHub, VM dédiée et preuves expérimentales

## Conclusion

Aucun dépôt GitHub trouvé ne fournit à lui seul les quatre preuves exigées par Open Cortex : identité exacte de l’image et du conteneur, hash du filtre seccomp effectivement chargé, quota global du workspace en rootless et certification persistante.

La solution réaliste est une architecture en deux parties :

1. utiliser les composants upstream Podman/crun et `containers/oci-seccomp-bpf-hook` pour préparer et tester les profils seccomp ;
2. exécuter la certification dans une VM Linux dédiée dont le filesystem de workspace est préparé par l’administrateur avec un quota de projet effectif.

Le runner reste rootless pour les conteneurs et refuse la certification si les preuves expérimentales ne sont pas produites.

## Ce que fournit réellement le dépôt GitHub seccomp

Le dépôt [containers/oci-seccomp-bpf-hook](https://github.com/containers/oci-seccomp-bpf-hook) trace les appels système d’un conteneur via un hook OCI et produit un profil seccomp. Sa documentation indique que le hook utilise eBPF, identifie les processus via le PID namespace et nécessite `CAP_SYS_ADMIN`. Il ne constitue donc pas une preuve rootless du hash du filtre BPF chargé par crun.

La conclusion opérationnelle est la suivante :

- le hook peut servir à générer ou réviser un profil de référence sur la VM de laboratoire ;
- il ne doit pas être exécuté dans le runner rootless comme preuve de certification ;
- `seccompProfileProof` reste `NOT RUN` tant qu’une mesure fiable et liée au conteneur réel n’est pas disponible ;
- un test comportemental d’un syscall interdit peut prouver que seccomp agit, mais ne prouve pas l’identité cryptographique du filtre chargé.

Podman expose le mode seccomp et le profil demandé, mais ces informations ne sont pas équivalentes à une mesure du programme BPF effectivement chargé dans le noyau.

## Solution de quota réellement applicable

Les limitations documentées dans [Podman issue #16424](https://github.com/podman-container-tools/podman/issues/16424) montrent que le quota disque rootless dépend du filesystem et des project quotas. Une option `storage-opt size` ou une taille de tmpfs ne prouve pas un quota global du workspace bind-mounté.

La solution recommandée pour la VM est :

1. créer un volume dédié au laboratoire ;
2. le formater avec XFS et l’option `prjquota`, ou utiliser un filesystem fournissant un mécanisme de quota de projet équivalent ;
3. configurer, par une étape administrative hors du runner, un projet quota par workspace ;
4. exposer uniquement le répertoire déjà préparé au processus rootless ;
5. vérifier le quota côté hôte et côté conteneur ;
6. remplir progressivement l’ensemble du workspace avec plusieurs fichiers et sous-répertoires ;
7. distinguer quota atteint, filesystem plein et permission refusée ;
8. conserver `storage=fail` si une seule de ces observations est ambiguë.

Cette étape administrative n’est pas un fallback rootful du runner : elle prépare la VM avant les tests. Le conteneur lui-même reste rootless, non privilégié et sans `--cgroupns=host`.

## Procédure expérimentale à ajouter à la VM

La validation finale doit produire séparément :

- `podman info` et la preuve rootless ;
- la version et le chemin de crun ;
- cgroups v2 et contrôleurs actifs ;
- le digest de l’image inspectée avant création ;
- l’ID complet du conteneur créé et inspecté ;
- les limites cgroup observées dans le cgroup propre au processus ;
- la sortie de la sonde et son lien avec le conteneur ;
- les résultats de chaque test d’évasion ;
- la preuve de quota côté hôte et côté conteneur ;
- le statut seccomp : `measured` seulement si la méthode mesure effectivement le filtre chargé, sinon `NOT RUN`.

## Décision pour Open Cortex

Il ne faut pas remplacer `NOT RUN` par une valeur déclarative. La prochaine étape utile n’est pas de modifier davantage la logique de certification dans le sandbox imbriqué. Il faut fournir une VM Linux dédiée ou un hôte Linux de laboratoire avec :

- Podman rootless et crun ;
- cgroups v2 pleinement contrôlables ;
- filesystem de workspace préparé avec project quota ;
- accès administrateur uniquement pour la préparation initiale et l’inspection des preuves ;
- compte utilisateur dédié pour l’exécution rootless.

Sans cet environnement, le verdict correct reste :

```text
FAIL / NOT RUN — P0 CERTIFICATION NOT GRANTED
```

## Sources

- Podman, génération de profils seccomp et limites du traçage : https://podman.io/blogs/2019/10/15/generate-seccomp-profiles
- OCI seccomp BPF hook : https://github.com/containers/oci-seccomp-bpf-hook
- Podman, quotas disque rootless : https://github.com/podman-container-tools/podman/issues/16424
- Podman `run`, limites CPU/cgroups et rootless : https://docs.podman.io/en/latest/markdown/podman-run.1.html
- crun, runtime OCI et seccomp : https://github.com/containers/crun
