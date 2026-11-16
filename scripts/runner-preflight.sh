#!/usr/bin/env bash
set -euo pipefail

fail=0
pass() { printf 'PASS %-24s %s\n' "$1" "$2"; }
failcheck() { printf 'FAIL %-24s %s\n' "$1" "$2"; fail=1; }

[ "$(uname -s)" = Linux ] && pass linux "Linux" || failcheck linux "Linux requis"
command -v podman >/dev/null && pass podman "$(podman --version)" || failcheck podman "podman absent"
command -v crun >/dev/null && pass crun "$(crun --version | head -1)" || failcheck crun "crun absent"
[ "$(stat -fc %T /sys/fs/cgroup 2>/dev/null || true)" = cgroup2fs ] && pass cgroups "cgroups v2" || failcheck cgroups "cgroups v2 requis"

info="$(podman info --format json 2>/dev/null || true)"
if [ -n "$info" ] && printf '%s' "$info" | jq -e '.host.security.rootless == true and .host.ociRuntime.name == "crun" and .host.cgroupVersion == "v2"' >/dev/null; then
  pass backend "rootless + crun + cgroups v2"
else
  failcheck backend "backend rootless/crun/cgroups v2 non confirmé"
fi

uid_map="$(podman unshare cat /proc/self/uid_map 2>/dev/null || true)"
gid_map="$(podman unshare cat /proc/self/gid_map 2>/dev/null || true)"
if printf '%s\n' "$uid_map" | awk '$1 == 1 && $3 >= 65536 { ok=1 } END { exit !ok }' && printf '%s\n' "$gid_map" | awk '$1 == 1 && $3 >= 65536 { ok=1 } END { exit !ok }'; then
  pass mapping "UID/GID subordinate ranges"
else
  failcheck mapping "mapping effectif incomplet: uid=[$uid_map] gid=[$gid_map]"
fi

if [ "${RUNNER_PREFLIGHT_SKIP_IMAGE:-0}" = 1 ]; then
  printf 'NOT RUN image                image différée : construction rootless requise\n'
elif [[ "${CORTEX_RUNNER_IMAGE:-}" =~ ^.+@sha256:[a-f0-9]{64}$ ]]; then
  if podman image exists "$CORTEX_RUNNER_IMAGE" >/dev/null 2>&1; then pass image "$CORTEX_RUNNER_IMAGE"; else failcheck image "image digest absente localement"; fi
else
  failcheck image "CORTEX_RUNNER_IMAGE doit être un digest sha256"
fi

if [ "$fail" -ne 0 ]; then
  printf '\nNOT READY: aucun test d’exécution ou d’évasion n’est lancé.\n'
  exit 2
fi
printf '\nREADY: préconditions présentes; lancer ensuite la suite d’attestation dédiée.\n'
