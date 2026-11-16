#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo 'Exécuter ce script depuis la session de l’utilisateur dédié, pas comme root.' >&2
  exit 2
fi

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  podman crun buildah uidmap slirp4netns fuse-overlayfs jq openssl git ca-certificates

user="$(id -un)"
if ! grep -q "^${user}:100000:65536$" /etc/subuid; then
  sudo usermod --add-subuids 100000-165535 "$user"
fi
if ! grep -q "^${user}:100000:65536$" /etc/subgid; then
  sudo usermod --add-subgids 100000-165535 "$user"
fi

mkdir -p "$HOME/.config/containers"
cat > "$HOME/.config/containers/containers.conf" <<'EOF'
[engine]
cgroup_manager = "cgroupfs"

[containers]
log_driver = "k8s-file"
EOF

cat <<'EOF'
Installation terminée. Fermer puis rouvrir la session utilisateur avant la prévalidation.
La certification exige ensuite :
  podman unshare cat /proc/self/uid_map
  podman unshare cat /proc/self/gid_map
avec une plage secondaire effective d’au moins 65536 identifiants.
EOF
