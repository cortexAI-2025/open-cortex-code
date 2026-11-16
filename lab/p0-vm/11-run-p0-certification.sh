#!/usr/bin/env bash
set -uo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
base_out="${P0_EVIDENCE_DIR:-$root/evidence}"
mkdir -p "$base_out"
session="$(openssl rand -hex 16)"
out="$base_out/run-$session"
mkdir -p "$out"
export P0_EVIDENCE_DIR="$out" P0_SESSION_ID="$session"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
worst=0
: > "$out/11-orchestrator.log"
printf 'step\texitCode\tdurationSeconds\n' > "$out/11-step-status.tsv"

run() {
  local step="$1" rc begin end
  begin="$(date +%s)"
  printf '=== %s ===\n' "$step" | tee -a "$out/11-orchestrator.log"
  "$root/$step" >"$out/$step.stdout" 2>"$out/$step.stderr"
  rc=$?
  end="$(date +%s)"
  cat "$out/$step.stdout" "$out/$step.stderr" >> "$out/$step.log"
  printf '%s\t%s\t%s\n' "$step" "$rc" "$((end - begin))" >> "$out/11-step-status.tsv"
  printf '%s=%s duration=%ss\n' "$step" "$rc" "$((end - begin))" | tee -a "$out/11-orchestrator.log"
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" -eq 77 ]; then
      [ "$worst" -eq 0 ] && worst=77
    else
      worst=1
    fi
  fi
  return 0
}

run 00-check-host.sh
run 05-verify-runtime.sh
run 06-build-runner-image.sh
if [ -s "$out/06-image-reference.txt" ]; then
  export CORTEX_RUNNER_IMAGE="$(cat "$out/06-image-reference.txt")"
else
  printf 'CORTEX_RUNNER_IMAGE=UNAVAILABLE\n' > "$out/11-config.txt"
fi

if [ -n "${P0_WORKSPACE:-}" ] && [ -n "${P0_WORKSPACE_QUOTA_BYTES:-}" ] && [ -n "${P0_PROJECT_ID:-}" ] && [ -n "${CORTEX_RUNNER_IMAGE:-}" ]; then
  run 07-run-isolation-tests.sh
  run 08-run-storage-tests.sh
else
  printf 'dependent steps=77 missing prerequisites\n' | tee -a "$out/11-orchestrator.log"
  [ "$worst" -ne 1 ] && worst=77
fi
run 09-run-seccomp-tests.sh
run 10-generate-attestation.sh

# Certification is deliberately stricter than successful script exit codes. In particular,
# requested seccomp configuration, Seccomp: 2, a local profile hash, or a hash manifest alone
# are not proof of the loaded BPF filter or a protected attestation signature.
proofs_ok=1
for step in 00-check-host.sh 05-verify-runtime.sh 06-build-runner-image.sh 07-run-isolation-tests.sh 08-run-storage-tests.sh 09-run-seccomp-tests.sh 10-generate-attestation.sh; do
  rc="$(awk -F '\t' -v wanted="$step" '$1 == wanted { value=$2 } END { if (value == "") print "MISSING"; else print value }' "$out/11-step-status.tsv")"
  if [ "$rc" != 0 ]; then proofs_ok=0; fi
done
if ! grep -Fxq 'PASS isolation-observed' "$out/07-run-isolation-tests.sh.stdout" 2>/dev/null; then proofs_ok=0; fi
if ! grep -Fxq 'GLOBAL_WORKSPACE_QUOTA=PASS' "$out/08-global-result.txt" 2>/dev/null; then proofs_ok=0; fi
if ! grep -Eq '^loaded_profile_hash=sha256:[a-f0-9]{64}$' "$out/09-seccomp-status.txt" 2>/dev/null; then proofs_ok=0; fi
if ! python3 - "$out/10-attestation.json" <<'PY'
import json, pathlib, sys
try:
    attestation = json.loads(pathlib.Path(sys.argv[1]).read_text())
    signature = attestation.get('signature', {})
    # A JSON status string is not a cryptographic signature or verification result.
    # The current lab verifier has no protected signing key/trust-anchor workflow.
    ok = False
except Exception:
    ok = False
raise SystemExit(0 if ok else 1)
PY
then
  proofs_ok=0
fi

finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Deliberately no success transition exists until the lab has an independently
# verifiable protected-signature implementation and the VM-only proofs are run.
verdict='FAIL / NOT RUN — P0 CERTIFICATION NOT GRANTED'
workflow_status='BLOCKED'
[ "$worst" -ne 0 ] || worst=77
exit_code="$worst"
cat > "$out/11-final-verdict.txt" <<EOF
schemaVersion=1
sessionId=$session
startedAt=$started
finishedAt=$finished
imageReference=${CORTEX_RUNNER_IMAGE:-UNAVAILABLE}
workflowStatus=$workflow_status
seccompLoadedProfile=$(if [ "$proofs_ok" -eq 1 ]; then echo MEASURED; else echo 'NOT RUN OR UNVERIFIED'; fi)
globalWorkspaceQuota=$(if grep -Fxq 'GLOBAL_WORKSPACE_QUOTA=PASS' "$out/08-global-result.txt" 2>/dev/null; then echo PASS; else echo 'NOT RUN OR UNVERIFIED'; fi)
protectedAttestationSignature=$(if [ "$proofs_ok" -eq 1 ]; then echo VERIFIED; else echo 'NOT RUN OR UNVERIFIED'; fi)
certificationTransition=DISABLED_UNTIL_PROTECTED_SIGNATURE_VERIFICATION_EXISTS
verdict=$verdict
exitCode=$exit_code
evidenceDirectory=$out
EOF
cat "$out/11-final-verdict.txt"
exit "$exit_code"
