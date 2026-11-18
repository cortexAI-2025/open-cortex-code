#!/usr/bin/env bash
set -euo pipefail
: "${1:?Usage: verify-attestation.sh <evidence-dir>}"; dir="$1"; json="$dir/10-attestation.json"; manifest="$dir/10-evidence-manifest.sha256"
[ -s "$json" ] && [ -s "$manifest" ] || { echo 'FAIL attestation-or-manifest-missing'; exit 1; }
python3 - "$json" "$manifest" <<'PY'
import hashlib, json, pathlib, sys
obj=json.loads(pathlib.Path(sys.argv[1]).read_text()); expected=obj.get('sessionId');
if obj.get('schemaVersion') != 1 or not expected or obj.get('signature',{}).get('status') != 'UNAVAILABLE': raise SystemExit('FAIL schema-or-signature-status')
for line in pathlib.Path(sys.argv[2]).read_text().splitlines():
    parts=line.split(maxsplit=1)
    if len(parts)!=2 or parts[0]=='MISSING': raise SystemExit('FAIL missing-evidence')
    digest,path=parts
    if hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()!=digest: raise SystemExit('FAIL evidence-modified')
print('PASS manifest-integrity-independent')
PY
