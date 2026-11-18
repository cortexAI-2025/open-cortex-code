#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo 'Refus: ne pas configurer le runner en root.' >&2; exit 2; }
u="$(id -un)"; sudo usermod --add-subuids 100000-165535 "$u"; sudo usermod --add-subgids 100000-165535 "$u"
mkdir -p "$HOME/.config/containers"
cat > "$HOME/.config/containers/containers.conf" <<'EOF'
[engine]
cgroup_manager = "systemd"
[containers]
log_driver = "k8s-file"
EOF
podman info --format json > "${P0_EVIDENCE_DIR:-lab/p0-vm/evidence}/02-podman-info.json" || { echo 'NOT RUN reconnect-session'; exit 77; }
