#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/lab/validation-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$out"
status=0
record() {
  local name="$1" rc="$2"; shift 2
  {
    printf 'name=%s\n' "$name"
    printf 'timestamp=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'exit=%s\n' "$rc"
    printf 'status=%s\n' "$([ "$rc" -eq 0 ] && echo PASS || echo FAIL)"
    printf 'command=%q ' "$@"; printf '\n'
  } > "$out/$name.meta"
}

set +e
RUNNER_PREFLIGHT_SKIP_IMAGE=1 "$root/scripts/runner-preflight.sh" > "$out/preflight-system.log" 2>&1
preflight_rc=$?
set -e
record preflight-system "$preflight_rc" "$root/scripts/runner-preflight.sh"
if [ "$preflight_rc" -ne 0 ]; then
  printf 'NOT RUN: preflight non valide\n' | tee "$out/summary.txt"
  printf 'status=NOT RUN\nreason=preflight\ntimestamp=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$out/summary.meta"
  exit 77
fi

if [ -z "${CORTEX_RUNNER_IMAGE:-}" ]; then
  image="localhost/open-cortex-runner:lab"
  podman build --network=host -t "$image" -f "$root/lab/runner/Containerfile" "$root/lab/runner" > "$out/build.log" 2>&1
  digest="$(podman image inspect "$image" --format '{{.Digest}}')"
  export CORTEX_RUNNER_IMAGE="localhost/open-cortex-runner@$digest"
else
  printf 'image=%s\n' "$CORTEX_RUNNER_IMAGE" > "$out/image.txt"
fi

"$root/scripts/runner-preflight.sh" > "$out/preflight-image.log" 2>&1

set +e
"$root/scripts/runner-escape-suite.sh" > "$out/escape.log" 2>&1
escape_rc=$?
set -e
record escape "$escape_rc" "$root/scripts/runner-escape-suite.sh"
if [ "$escape_rc" -ne 0 ]; then status=1; fi
printf 'status=%s\n' "$([ "$status" -eq 0 ] && echo PASS || echo FAIL)" > "$out/summary.meta"
cat "$out/escape.log"
exit "$status"
