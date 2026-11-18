#!/usr/bin/env bash
set -euo pipefail
out="${P0_EVIDENCE_DIR:-lab/p0-vm/evidence}"; mkdir -p "$out"
log="$out/00-check-host.log"; exec > >(tee "$log") 2>&1
fail=0
for c in uname findmnt stat awk jq; do command -v "$c" >/dev/null || { echo "FAIL missing=$c"; fail=1; }; done
[ "$(uname -s)" = Linux ] || { echo 'FAIL platform=not-linux'; fail=1; }
[ "$(id -u)" -ne 0 ] || { echo 'FAIL runner-must-not-run-as-root'; fail=1; }
uname -a; cat /etc/os-release; findmnt -no TARGET,FSTYPE,OPTIONS /; stat -f -c 'filesystem=%T' .
if [ "$fail" -eq 0 ]; then echo 'PASS host-baseline'; else echo 'NOT RUN host-baseline'; exit 77; fi
