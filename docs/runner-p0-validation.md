# Procédure de validation P0 du runner isolé

Cette procédure doit être exécutée sur une VM Linux dédiée, non imbriquée et non utilisée pour la production. Elle ne doit pas être remplacée par un conteneur privilégié ou par `--cgroupns=host`.

## Préparation système

Sur Ubuntu 24.04 :

```bash
sudo apt-get update
sudo apt-get install -y podman crun buildah uidmap slirp4netns fuse-overlayfs jq
sudo usermod --add-subuids 100000-165535 "$USER"
sudo usermod --add-subgids 100000-165535 "$USER"
```

Ouvrir une nouvelle session utilisateur, puis vérifier :

```bash
podman info --format json | jq '{rootless:.host.security.rootless,runtime:.host.ociRuntime.name,cgroups:.host.cgroupVersion,seccomp:.host.security.seccompEnabled}'
podman unshare cat /proc/self/uid_map
podman unshare cat /proc/self/gid_map
```

La cartographie doit contenir une plage secondaire effective, typiquement :

```text
0       <uid-utilisateur>  1
1       100000             65536
```

Une simple entrée `0 <uid> 1` est insuffisante et doit produire un refus.

## Prévalidation

Depuis la racine du dépôt :

```bash
./scripts/runner-preflight.sh
```

Le script doit produire `READY`. Toute sortie `FAIL` ou `NOT READY` interdit les tests d’exécution.

## Construction de l’image

L’image doit être construite rootless et avec un digest immutable :

```bash
podman build --network=host \
  -t localhost/open-cortex-runner:lab \
  -f lab/runner/Containerfile lab/runner

DIGEST="$(podman image inspect localhost/open-cortex-runner:lab --format '{{.Digest}}')"
case "$DIGEST" in sha256:????????????????????????????????????????????????????????????????) ;; *) exit 1;; esac
export CORTEX_RUNNER_IMAGE="localhost/open-cortex-runner@$DIGEST"
```

Le digest doit être conservé avec les preuves. Un tag seul, une image rootful ou une image mutable ne sont pas acceptés.

## Attestation et évasion

```bash
./scripts/runner-escape-suite.sh
```

La suite doit être exécutée avec `userns=private`, `pid=private`, `ipc=private`, `uts=private`, `cgroupns=private`, `network=none`, filesystem read-only, seccomp et `no-new-privileges`. Si une précondition manque, le script doit afficher `NOT RUN`, jamais `PASS`.

## Conditions de certification

La certification n’est accordée que si les conditions suivantes sont simultanément démontrées :

- mapping UID/GID complet et réellement utilisé ;
- Podman rootless et runtime crun ;
- cgroups v2 privés effectivement opérationnels ;
- image vérifiée par digest ;
- profil seccomp chargé et hashé ;
- attestation interne et externe réussies dans le conteneur réellement utilisé ;
- quota du workspace complet démontré, pas uniquement un quota `/tmp` ;
- réseau désactivé ;
- aucun socket Docker/Podman exposé ;
- tests d’évasion, limites et nettoyage après crash exécutés avec preuves ;
- aucun fallback rootful ou hôte.

Le runner reste en refus fermé tant que l’un de ces points est `FAIL` ou `NOT RUN`.
