#!/usr/bin/env bash
set -euo pipefail
out="${P0_EVIDENCE_DIR:-lab/p0-vm/evidence}"; mkdir -p "$out"
podman info --debug > "$out/05-podman-info-debug.txt"
podman info --format json > "$out/05-podman-info.json"
jq '{rootless:.host.security.rootless,cgroups:.host.cgroupVersion,runtime:.host.ociRuntime,seccomp:.host.security.seccompEnabled}' "$out/05-podman-info.json"
crun --version
podman unshare cat /proc/self/uid_map
podman unshare cat /proc/self/gid_map
