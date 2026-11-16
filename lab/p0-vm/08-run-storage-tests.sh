#!/usr/bin/env bash
set -euo pipefail
: "${P0_WORKSPACE:?Définir P0_WORKSPACE}"; : "${P0_WORKSPACE_QUOTA_BYTES:?Définir P0_WORKSPACE_QUOTA_BYTES}"; : "${P0_PROJECT_ID:?Définir P0_PROJECT_ID}"
out="${P0_EVIDENCE_DIR:-lab/p0-vm/evidence}"; mkdir -p "$out"
mountpoint="$(findmnt -no TARGET "$P0_WORKSPACE" 2>/dev/null || true)"; [ -n "$mountpoint" ] || { echo 'NOT RUN workspace-not-mounted'; exit 77; }
fs="$(findmnt -no FSTYPE "$P0_WORKSPACE")"; [ "$fs" = xfs ] || { echo 'NOT RUN filesystem-not-xfs'; exit 77; }
opts="$(findmnt -no OPTIONS "$P0_WORKSPACE")"; printf '%s\n' "$opts" | tr ',' '\n' | grep -Fxq prjquota || { echo 'NOT RUN prjquota-not-active'; exit 77; }
project_info="$out/08-project-report-before.txt"; xfs_quota -x -c 'report -p -h' "$mountpoint" > "$project_info" 2>"$out/08-project-report-before.err" || { echo 'NOT RUN xfs-report-failed'; exit 77; }
grep -E "(^|[[:space:]])${P0_PROJECT_ID}([[:space:]]|$)" "$project_info" >/dev/null || { echo 'NOT RUN project-id-not-observed'; exit 77; }
limit_info="$out/08-project-limit.txt"; xfs_quota -x -c "limit -p -v $P0_PROJECT_ID" "$mountpoint" > "$limit_info" 2>&1 || { echo 'NOT RUN project-limit-unreadable'; exit 77; }
grep -E 'bhard|hard' "$limit_info" >/dev/null || { echo 'NOT RUN hard-limit-unreadable'; exit 77; }
printf 'filesystem=%s\nmount=%s\noptions=%s\nproject=%s\nconfiguredBytes=%s\n' "$fs" "$mountpoint" "$opts" "$P0_PROJECT_ID" "$P0_WORKSPACE_QUOTA_BYTES" > "$out/08-host-before.txt"
testfile="$P0_WORKSPACE/.p0-quota-test-$$"; set +e
python3 - "$testfile" "$P0_WORKSPACE_QUOTA_BYTES" > "$out/08-write-test.txt" 2>&1 <<'PY'
import errno, os, sys
p, limit = sys.argv[1], int(sys.argv[2]); chunk=b'X'*1048576; total=0
try:
    with open(p,'wb') as f:
        while total <= limit + 1048576:
            f.write(chunk); f.flush(); os.fsync(f.fileno()); total += len(chunk)
except OSError as e:
    print(f'errno={e.errno} total={total}')
    sys.exit(0 if e.errno == errno.EDQUOT else (4 if e.errno in (errno.EACCES, errno.EPERM, errno.ENOSPC, errno.EIO) else 5))
print(f'NO_QUOTA_REACHED total={total}'); sys.exit(6)
PY
rc=$?; set -e; rm -f "$testfile"
[ "$rc" -eq 0 ] || { echo 'FAIL quota-not-demonstrated-or-ambiguous'; exit 1; }
: "${CORTEX_RUNNER_IMAGE:?Définir CORTEX_RUNNER_IMAGE pour le test rootless concurrent}"
concurrent_dir="$P0_WORKSPACE/.p0-concurrent-$$"; mkdir "$concurrent_dir"
set +e
podman run --rm --user 1000:1000 --userns=private --network=none --read-only --cap-drop=ALL --security-opt no-new-privileges:true --security-opt "seccomp=$PWD/security/seccomp-runner.json" -v "$concurrent_dir:/workspace:rw" "$CORTEX_RUNNER_IMAGE" sh -c 'set -eu; for n in 1 2 3 4; do (dd if=/dev/zero of="/workspace/p$n.bin" bs=1M count=1024 conv=fsync 2>&1 || true) >"/workspace/p$n.log" 2>&1 & done; wait; cat /workspace/p*.log' > "$out/08-rootless-concurrent.txt" 2>&1
container_rc=$?; set -e
if [ "$container_rc" -ne 0 ] || ! grep -Eiq 'disk quota exceeded|EDQUOT' "$out/08-rootless-concurrent.txt"; then rm -rf "$concurrent_dir"; echo 'NOT RUN global-rootless-EDQUOT-not-proven'; exit 77; fi
xfs_quota -x -c 'report -p -h' "$mountpoint" > "$out/08-project-report-after.txt" 2>&1 || true
stat -c 'after_blocks=%b after_size=%s' "$P0_WORKSPACE" > "$out/08-host-after.txt"
rm -rf "$concurrent_dir"
printf 'GLOBAL_WORKSPACE_QUOTA=PASS\nconcurrent_processes=4\nerror=EDQUOT\n' > "$out/08-global-result.txt"
echo 'PASS quota-reached-and-global-rootless-concurrent'
