#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo 'Refus: lancer depuis le compte utilisateur, sudo est utilisé explicitement.' >&2; exit 2; }
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y podman crun buildah uidmap slirp4netns fuse-overlayfs jq xfsprogs quota util-linux openssl
command -v podman; command -v crun; command -v xfs_quota; echo 'PASS dependencies-installed'
