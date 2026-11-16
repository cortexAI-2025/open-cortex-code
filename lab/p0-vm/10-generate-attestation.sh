#!/usr/bin/env bash
set -euo pipefail
out="${P0_EVIDENCE_DIR:-lab/p0-vm/evidence}"; mkdir -p "$out"; : "${P0_SESSION_ID:=unknown}"
[ -s "$out/06-image-reference.txt" ] || { echo 'NOT RUN image-reference-missing'; exit 77; }
start="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; session="${P0_SESSION_ID:-$(openssl rand -hex 16)}"; manifest="$out/10-evidence-manifest.sha256"
: > "$manifest"
for f in "$out/06-image-id.txt" "$out/06-repo-digest.txt" "$out/06-image-reference.txt" "$out/07-probe.log" "$out/08-project-report-after.txt" "$out/09-seccomp-status.txt"; do [ -f "$f" ] && sha256sum "$f" >> "$manifest" || printf 'MISSING  %s\n' "$f" >> "$manifest"; done
kernel="$(uname -srmo)"; podman_version="$(podman --version 2>/dev/null || echo unavailable)"; crun_version="$(crun --version 2>/dev/null | head -1 || echo unavailable)"; end="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 - "$out/10-attestation.json" "$manifest" "$session" "$start" "$end" "$kernel" "$podman_version" "$crun_version" <<'PY'
import hashlib, json, pathlib, sys
out, manifest, session, start, end, kernel, podman, crun=sys.argv[1:]
entries=[]
for line in pathlib.Path(manifest).read_text().splitlines():
    parts=line.split(maxsplit=1); entries.append({'sha256':parts[0], 'path':parts[1] if len(parts)>1 else ''})
obj={'schemaVersion':1,'sessionId':session,'startedAt':start,'finishedAt':end,'environment':{'kernel':kernel,'podman':podman,'crun':crun,'uid':__import__('os').getuid()},'image':{'reference':pathlib.Path(out).parent.joinpath('06-image-reference.txt').read_text().strip()},'tests':{'isolation':'SEE_07','quota':'SEE_08','seccompLoadedProfile':'NOT RUN'},'evidenceManifest':entries,'signature':{'status':'UNAVAILABLE','reason':'clé protégée hors environnement non disponible'}}
pathlib.Path(out).write_text(json.dumps(obj,indent=2)+'\n')
PY
cp "$manifest" "$out/10-attestation.manifest.sha256"
echo 'NOT RUN protected-signature-unavailable'; exit 77
