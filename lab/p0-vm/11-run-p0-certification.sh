#!/usr/bin/env bash
set -uo pipefail
root="$(cd "$(dirname "$0")" && pwd)"; out="${P0_EVIDENCE_DIR:-$root/evidence}"; mkdir -p "$out"; export P0_EVIDENCE_DIR="$out"
worst=0; session="$(openssl rand -hex 16)"; started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; : > "$out/11-orchestrator.log"
run(){ local step="$1"; local rc; local begin end; begin="$(date +%s)"; echo "=== $step ===" | tee -a "$out/11-orchestrator.log"; "$root/$step" >"$out/$step.stdout" 2>"$out/$step.stderr"; rc=$?; end="$(date +%s)"; cat "$out/$step.stdout" "$out/$step.stderr" >> "$out/$step.log"; echo "$step=$rc duration=$((end-begin))s" | tee -a "$out/11-orchestrator.log"; if [ "$rc" -eq 1 ]; then worst=1; elif [ "$rc" -eq 77 ] && [ "$worst" -eq 0 ]; then worst=77; fi; return 0; }
run 00-check-host.sh; run 05-verify-runtime.sh; run 06-build-runner-image.sh
if [ -s "$out/06-image-reference.txt" ]; then export CORTEX_RUNNER_IMAGE="$(cat "$out/06-image-reference.txt")"; else echo 'CORTEX_RUNNER_IMAGE=UNAVAILABLE' > "$out/11-config.txt"; fi
if [ -n "${P0_WORKSPACE:-}" ] && [ -n "${P0_WORKSPACE_QUOTA_BYTES:-}" ] && [ -n "${P0_PROJECT_ID:-}" ] && [ -n "${CORTEX_RUNNER_IMAGE:-}" ]; then run 07-run-isolation-tests.sh; run 08-run-storage-tests.sh; else echo 'dependent steps=77 missing prerequisites' | tee -a "$out/11-orchestrator.log"; [ "$worst" -eq 0 ] && worst=77; fi
run 09-run-seccomp-tests.sh; run 10-generate-attestation.sh
finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ "$worst" -eq 1 ]; then verdict='FAIL / NOT RUN — P0 CERTIFICATION NOT GRANTED'; elif [ "$worst" -eq 77 ]; then verdict='FAIL / NOT RUN — P0 CERTIFICATION NOT GRANTED'; else verdict='FAIL / NOT RUN — P0 CERTIFICATION NOT GRANTED'; fi
cat > "$out/11-final-verdict.txt" <<EOF
schemaVersion=1
sessionId=$session
startedAt=$started
finishedAt=$finished
imageReference=${CORTEX_RUNNER_IMAGE:-UNAVAILABLE}
workflowStatus=COLLECTED
seccompLoadedProfile=NOT RUN
globalWorkspaceQuota=${GLOBAL_WORKSPACE_QUOTA:-NOT RUN}
verdict=$verdict
exitCode=$worst
EOF
cat "$out/11-final-verdict.txt"; exit "$worst"
