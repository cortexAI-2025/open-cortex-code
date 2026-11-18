#!/usr/bin/env bash
set -euo pipefail
: "${CORTEX_RUNNER_IMAGE:?Exporter CORTEX_RUNNER_IMAGE depuis 06-build-runner-image.sh}"
out="${P0_EVIDENCE_DIR:-lab/p0-vm/evidence}"; mkdir -p "$out"; nonce="$(openssl rand -hex 32)"; printf '%s\n' "$nonce" > "$out/07-nonce.txt"
for ns in user pid net mnt ipc uts cgroup; do printf '%s=%s\n' "$ns" "$(readlink "/proc/self/ns/$ns")"; done > "$out/07-host-namespaces.txt"
set +e
podman run --rm --name cortex-p0-isolation --user 1000:1000 --userns=private --pid=private --ipc=private --uts=private --cgroupns=private --network=none --read-only --cap-drop=ALL --security-opt no-new-privileges:true --security-opt "seccomp=$PWD/security/seccomp-runner.json" --memory 268435456 --cpus 1 --pids-limit 64 --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m --env "CORTEX_PROBE_NONCE=$nonce" "$CORTEX_RUNNER_IMAGE" /usr/local/bin/cortex-runner-probe > "$out/07-probe.log" 2>&1
rc=$?; set -e
cat "$out/07-probe.log"
[ "$rc" -eq 0 ] || { echo 'NOT RUN probe-command-failed'; exit 77; }
grep -Fx "nonce=$nonce" "$out/07-probe.log" >/dev/null || { echo 'FAIL nonce-mismatch'; exit 1; }
grep -Eq '^uid=[1-9][0-9]*$' "$out/07-probe.log" || { echo 'FAIL uid-root-or-missing'; exit 1; }
grep -Eq '^gid=[1-9][0-9]*$' "$out/07-probe.log" || { echo 'FAIL gid-root-or-missing'; exit 1; }
for proof in runner-attestation-ok networkNone=true networkIPv6None=true rootReadOnly=true hostSocketsAbsent=true noNewPrivileges=1; do grep -Fx "$proof" "$out/07-probe.log" >/dev/null || { echo "FAIL missing=$proof"; exit 1; }; done
grep -Eq '^capEff=(0+|0000000000000000)$' "$out/07-probe.log" || { echo 'FAIL capabilities-nonzero'; exit 1; }
while IFS='=' read -r ns host_id; do grep -E "^ns_${ns}=" "$out/07-probe.log" | grep -Fv "$host_id" >/dev/null || { echo "FAIL namespace-shared=$ns"; exit 1; }; done < "$out/07-host-namespaces.txt"
echo 'PASS isolation-observed'
