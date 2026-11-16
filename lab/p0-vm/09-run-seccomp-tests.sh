#!/usr/bin/env bash
set -euo pipefail
out="${P0_EVIDENCE_DIR:-lab/p0-vm/evidence}"; mkdir -p "$out"
cat > "$out/09-seccomp-status.txt" <<EOF
requested_profile=$PWD/security/seccomp-runner.json
loaded_profile_hash=NOT RUN
reason=Podman/crun expose le mode seccomp et le profil demandé, mais pas une mesure fiable du filtre BPF effectivement chargé dans ce workflow rootless.
EOF
cat "$out/09-seccomp-status.txt"
echo 'NOT RUN seccomp-loaded-profile-measurement'; exit 77
