#!/bin/sh
set -eu

nonce="${CORTEX_PROBE_NONCE:-}"
uid="$(id -u)"
gid="$(id -g)"
status="$(cat /proc/self/status)"
cap_eff="$(printf '%s\n' "$status" | awk '/^CapEff:/{print $2}')"
no_new_privs="$(printf '%s\n' "$status" | awk '/^NoNewPrivs:/{print $2}')"
seccomp="$(printf '%s\n' "$status" | awk '/^Seccomp:/{print $2}')"
root_mount="$(awk '$5 == "/" {print $6; exit}' /proc/self/mountinfo)"
network_routes="$(awk 'NR > 1 && $2 != "00000000" {count++} END {print count+0}' /proc/net/route)"
network6_routes="$(awk 'NF >= 1 {count++} END {print count+0}' /proc/net/ipv6_route)"
cgroup_line="$(grep '^0::' /proc/self/cgroup)"
cgroup_rel="${cgroup_line#0::}"
cgroup_path="/sys/fs/cgroup${cgroup_rel}"
cgroup_controllers="$(cat "$cgroup_path/cgroup.controllers" 2>/dev/null || true)"
memory_max="$(cat "$cgroup_path/memory.max" 2>/dev/null || true)"
pids_max="$(cat "$cgroup_path/pids.max" 2>/dev/null || true)"
cpu_max="$(cat "$cgroup_path/cpu.max" 2>/dev/null || true)"
runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
socket_paths="/run/docker.sock /var/run/docker.sock /run/podman/podman.sock /var/run/podman/podman.sock $runtime_dir/podman/podman.sock $runtime_dir/podman.sock"

[ "$uid" -ne 0 ]
[ "$gid" -ge 0 ]
[ "$cap_eff" = 0000000000000000 ] || [ "$cap_eff" = 00000000 ]
[ "$no_new_privs" = 1 ]
[ "$seccomp" = 1 ] || [ "$seccomp" = 2 ]
[ -n "$nonce" ]
for socket in $socket_paths; do [ ! -S "$socket" ]; done
! awk '$3 ~ /\/run(\/user\/[^ ]+)?\/(docker|podman)(\/[^ ]+)?\.sock/ {found=1} END {exit found+0}' /proc/self/mounts
[ "$network_routes" = 0 ]
[ "$network6_routes" = 0 ]
printf '%s\n' "$cgroup_controllers" | grep -qw cpu
printf '%s\n' "$cgroup_controllers" | grep -qw memory
printf '%s\n' "$cgroup_controllers" | grep -qw pids
case ",$root_mount," in *,ro,*) ;; *) exit 1 ;; esac

for ns in user pid net mnt ipc uts cgroup; do
  [ -e "/proc/self/ns/$ns" ]
  readlink "/proc/self/ns/$ns" | grep -Eq '^[a-z]+:\[[0-9]+\]$'
done

[ -n "$cgroup_line" ]
[ -d "$cgroup_path" ]
[ "$memory_max" != max ] && [ -n "$memory_max" ]
[ "$pids_max" != max ] && [ -n "$pids_max" ]
[ "$cpu_max" != max ] && [ -n "$cpu_max" ]

printf 'runner-attestation-ok\n'
printf 'nonce=%s\n' "$nonce"
printf 'uid=%s\n' "$uid"
printf 'gid=%s\n' "$gid"
printf 'capEff=%s\n' "$cap_eff"
printf 'noNewPrivileges=%s\n' "$no_new_privs"
printf 'seccompMode=%s\n' "$seccomp"
printf 'networkNone=true\n'
printf 'networkIPv6None=true\n'
printf 'rootReadOnly=true\n'
printf 'hostSocketsAbsent=true\n'
printf 'cgroupControllers=%s\n' "$cgroup_controllers"
printf 'cgroup=%s\n' "$cgroup_line"
printf 'cgroupPath=%s\n' "$cgroup_path"
printf 'cgroupPathExists=true\n'
printf 'memoryMax=%s\n' "$memory_max"
printf 'pidsMax=%s\n' "$pids_max"
printf 'cpuMax=%s\n' "$cpu_max"
printf 'hostSocketsAbsent=true\n'
for ns in user pid net mnt ipc uts cgroup; do printf 'ns_%s=%s\n' "$ns" "$(readlink "/proc/self/ns/$ns")"; done
