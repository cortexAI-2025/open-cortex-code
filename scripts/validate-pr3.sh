#!/usr/bin/env bash
set -Eeuo pipefail

# Validation locale standard : ./scripts/validate-pr3.sh
# Inclure les sessions agentiques réelles contre Ollama local :
#   ./scripts/validate-pr3.sh --with-live-ollama
# Les tests Ollama écrivent leurs rapports dans artifacts/engine-test.json et
# artifacts/connector-test.json. Ils n'utilisent pas de fournisseur payant.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

RUN_LIVE_OLLAMA=false
case "${1:-}" in
  '') ;;
  --with-live-ollama) RUN_LIVE_OLLAMA=true ;;
  --help|-h)
    sed -n '1,7p' "$0"
    exit 0
    ;;
  *)
    printf 'Option inconnue: %s\nUsage: %s [--with-live-ollama]\n' "$1" "$0" >&2
    exit 2
    ;;
esac

step="initialisation"
trap 'status=$?; printf "\n[ÉCHEC] Étape: %s (code %s)\n" "$step" "$status" >&2; exit "$status"' ERR

run_step() {
  step="$1"
  shift
  printf '\n=== %s ===\n' "$step"
  "$@"
}

printf 'Projet: %s\n' "$PROJECT_ROOT"
printf 'Révision: %s\n' "$(git rev-parse --short HEAD 2>/dev/null || printf 'source sans Git')"

command -v node >/dev/null 2>&1 || { echo 'Node.js est requis.' >&2; exit 2; }
command -v pnpm >/dev/null 2>&1 || { echo 'pnpm est requis (version déclarée dans package.json).' >&2; exit 2; }

run_step 'Installation reproductible des dépendances' pnpm install --frozen-lockfile
run_step 'Typecheck TypeScript' pnpm typecheck
run_step 'Tests unitaires et intégration Vitest' pnpm test
run_step 'Build Web, serveur et Desktop' pnpm build

if [[ -n "${CHROMIUM_PATH:-}" ]]; then
  [[ -x "$CHROMIUM_PATH" ]] || { echo "CHROMIUM_PATH n'est pas exécutable: $CHROMIUM_PATH" >&2; exit 2; }
else
  chromium_found=false
  for browser in chromium chromium-browser google-chrome google-chrome-stable; do
    if command -v "$browser" >/dev/null 2>&1; then
      chromium_found=true
      break
    fi
  done
  if [[ "$chromium_found" != true ]]; then
    echo 'Chromium est requis pour les tests navigateur. Installez-le ou définissez CHROMIUM_PATH.' >&2
    exit 2
  fi
fi

run_step 'E2E navigateur Monaco (lazy load, conservation, reprise)' pnpm test:monaco-browser
run_step 'E2E navigateur vues différées' pnpm test:secondary-views-browser

if [[ "$RUN_LIVE_OLLAMA" == true ]]; then
  if ! curl --silent --show-error --fail http://127.0.0.1:11434/api/tags >/dev/null; then
    echo 'Ollama local doit être actif sur 127.0.0.1:11434 pour les tests agentiques réels.' >&2
    exit 2
  fi
  run_step 'Test agentique réel OpenCode 2.2.7 avec Ollama local' pnpm test:engine
  run_step 'Test d’intégration réel du connecteur avec Ollama local' pnpm test:connector
else
  printf '\nINFO: tests Ollama réels non lancés. Ajoutez --with-live-ollama pour les inclure.\n'
fi

trap - ERR
printf '\n[SUCCÈS] Tous les contrôles demandés par les options sélectionnées sont terminés.\n'
