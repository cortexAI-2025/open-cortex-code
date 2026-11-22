#!/usr/bin/env bash
# Starts the CTO IA and the Open Cortex connector together and waits until both answer.
# Usage: CTO_DIR=/path/to/CTO-AI-AIWORKPAY scripts/team-up.sh /path/to/project-repo
# Persistent config: ~/.opencortex/team.env (mode 600, created on first run, tokens generated locally, never printed).
set -eu
PROJECT="${1:?usage: team-up.sh <absolute path of the project repo the CTO works on>}"
CTO_DIR="${CTO_DIR:?set CTO_DIR to your CTO-AI-AIWORKPAY checkout}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CONF="${CORTEX_TEAM_ENV:-$HOME/.opencortex/team.env}"
mkdir -p "$(dirname "$CONF")"; chmod 700 "$(dirname "$CONF")"
if [ ! -f "$CONF" ]; then
  umask 077
  printf 'CTO_ADMIN_TOKEN=%s\nCTO_PORT=3000\nCORTEX_PORT=4000\n' "$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n')" > "$CONF"
fi
set -a; . "$CONF"; set +a
RUN="${CORTEX_TEAM_RUN:-$HOME/.opencortex/run}"; mkdir -p "$RUN"
( cd "$CTO_DIR" && node scripts/doctor.js ) || { echo "BLOCKED: runtime prerequisites missing (run: npm run setup:linux in $CTO_DIR)"; exit 1; }
[ -f "$HERE/dist-server/server/index.js" ] || ( cd "$HERE" && pnpm build )
# `cd` first, then background ONE simple command: $! is then the service itself (not a wrapper subshell).
cd "$CTO_DIR"
CTO_REPO_PATH="$PROJECT" CTO_DATA_DIR="${CTO_DATA_DIR:-$RUN/cto-data}" CTO_WORKSPACES_DIR="${CTO_WORKSPACES_DIR:-$RUN/cto-workspaces}" PORT="$CTO_PORT" \
  nohup node src/server.js > "$RUN/cto.log" 2>&1 < /dev/null &
echo $! > "$RUN/cto.pid"
cd "$HERE"
CORTEX_CTO_URL="http://127.0.0.1:$CTO_PORT" CORTEX_CTO_TOKEN="$CTO_ADMIN_TOKEN" CORTEX_PORT="$CORTEX_PORT" CORTEX_DATA_DIR="${CORTEX_DATA_DIR:-$RUN/occ-data}" \
  nohup node dist-server/server/index.js > "$RUN/occ.log" 2>&1 < /dev/null &
echo $! > "$RUN/occ.pid"
for i in $(seq 1 30); do
  curl -fs "http://127.0.0.1:$CTO_PORT/health" >/dev/null 2>&1 && curl -fs "http://127.0.0.1:$CORTEX_PORT/api/health" >/dev/null 2>&1 && break
  sleep 1; [ "$i" -lt 30 ] || { echo "services did not become healthy; see $RUN/*.log"; exit 1; }
done
echo "CTO IA        : http://127.0.0.1:$CTO_PORT (log $RUN/cto.log)"
echo "Open Cortex   : $(grep -o 'http://[^ ]*#token=[^ ]*' "$RUN/occ.log" | head -1)   (jeton de pairing local, ne pas partager)"
echo "Arrêt         : kill \$(cat $RUN/cto.pid $RUN/occ.pid)"
