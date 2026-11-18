#!/usr/bin/env bash
set -euo pipefail

image="${CORTEX_RUNNER_IMAGE:-}"
if ! [[ "$image" =~ ^.+@sha256:[a-f0-9]{64}$ ]]; then echo 'NOT RUN image: digest CORTEX_RUNNER_IMAGE absent ou invalide'; exit 77; fi
if ! podman info --format json 2>/dev/null | jq -e '.host.security.rootless == true and .host.ociRuntime.name == "crun" and .host.cgroupVersion == "v2"' >/dev/null; then echo 'NOT RUN backend: rootless/crun/cgroups v2 non confirmé'; exit 77; fi
if ! podman unshare cat /proc/self/uid_map | awk '$1 == 1 && $3 >= 65536 { ok=1 } END { exit !ok }'; then echo 'NOT RUN mapping: plage UID rootless complète absente'; exit 77; fi
if ! podman image exists "$image" >/dev/null 2>&1; then echo 'NOT RUN image: image absente localement'; exit 77; fi

seccomp="${CORTEX_SECCOMP_PROFILE:-$(cd "$(dirname "$0")/.." && pwd)/security/seccomp-runner.json}"
[ -f "$seccomp" ] || { echo 'NOT RUN seccomp: profil absent'; exit 77; }
nonce="${CORTEX_PROBE_NONCE:-$(openssl rand -hex 24)}"
workspace="$(mktemp -d -p "${TMPDIR:-/tmp}" cortex-escape.XXXXXX)"
trap 'rm -rf "$workspace"' EXIT
printf '%s\n' fixture > "$workspace/fixture.txt"

podman run --rm --name "cortex-escape-$RANDOM" \
  --userns=private --user 1000:1000 --pid=private --ipc=private --uts=private --cgroupns=private \
  --network=none --read-only --cap-drop=ALL --security-opt no-new-privileges:true \
  --security-opt "seccomp=$seccomp" --memory 256m --memory-swap 256m --cpus 1 --pids-limit 64 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec --mount "type=bind,src=$workspace,dst=/workspace,rw,nodev,nosuid" \
  --workdir /workspace --env "CORTEX_PROBE_NONCE=$nonce" "$image" /bin/sh -lc '
set -eu
fail=0
notrun=0
run_denied() {
  name="$1"; tool="$2"; expected="$3"; shift 3
  command -v "$tool" >/dev/null 2>&1 || { printf "NOT RUN %s missing-tool=%s\n" "$name" "$tool"; notrun=$((notrun+1)); return; }
  printf "TEST %s\n" "$name"
  set +e
  "$@" >/tmp/cortex-test-out 2>&1
  rc=$?
  set -e
  sed -n "1,8p" /tmp/cortex-test-out
  printf "RC %s\n" "$rc"
  if [ "$rc" -eq 0 ]; then printf "FAIL %s unexpected-success\n" "$name"; fail=$((fail+1)); elif ! grep -E "$expected" /tmp/cortex-test-out >/dev/null; then printf "FAIL %s unexpected-error\n" "$name"; fail=$((fail+1)); else printf "PASS %s evidence=%s\n" "$name" "$expected"; fi
}

[ "$(id -u)" -ne 0 ]
grep -Eq "^NoNewPrivs:[[:space:]]*1" /proc/self/status
grep -Eq "^Seccomp:[[:space:]]*[12]" /proc/self/status
grep -Eq "^CapEff:[[:space:]]*0+$" /proc/self/status
test ! -e /run/docker.sock
test ! -e /var/run/docker.sock
printf "PASS baseline\n"
  run_denied filesystem-write touch 'Read-only|Operation not permitted|Permission denied' touch /escape
  run_denied mount mount 'Operation not permitted|not superuser|Permission denied' mount -t proc proc /mnt
  run_denied unshare unshare 'Operation not permitted|Permission denied' unshare -Ur true
  run_denied setns nsenter 'Operation not permitted|Permission denied|No such process' nsenter -t 1 -m true
  run_denied host-file-read cat 'Permission denied|No such file|Operation not permitted' cat /proc/1/root/etc/shadow
  run_denied network wget 'Network is unreachable|Connection|failed|timed out' wget -q -T 2 -O /tmp/net-test http://198.18.0.1/
  run_denied bpf bpftool 'Operation not permitted|Permission denied|command not found' bpftool prog show
  run_denied ptrace strace 'Operation not permitted|Permission denied|ptrace' strace -p 1 -o /tmp/ptrace-out
  run_denied pid-limit sh 'Resource temporarily unavailable|cannot fork|Operation not permitted' sh -c "i=0; while [ \"\$i\" -lt 1000 ]; do sleep 60 & i=\$((i+1)); done"
  run_denied disk-limit dd 'No space|Read-only|Disk quota|Permission denied' dd if=/dev/zero of=/workspace/fill bs=1M count=512

if [ "$notrun" -gt 0 ]; then printf "NOT RUN count=%s\n" "$notrun"; exit 77; fi
if [ "$fail" -gt 0 ]; then printf "FAIL count=%s\n" "$fail"; exit 1; fi
printf "PASS escape-suite\n"
'
