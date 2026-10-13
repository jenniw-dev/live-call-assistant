#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$PROJECT_ROOT/release/Live Call Assistant.app"
SKIP_ARCHITECTURE_CHECK=false
SKIP_RUNTIME_CHECK=false
CUSTOM_APP=false

usage() {
  echo "Usage: bash scripts/verify-mac-bundle.sh [--app /path/to/Live Call Assistant.app] [--skip-architecture-check] [--fixture-skip-runtime-check]" >&2
}

fail() {
  echo "Bundle verification failed: $1" >&2
  exit 1
}

require_directory() {
  [[ -d "$1" ]] || fail "missing required directory: $1"
}

require_file() {
  [[ -f "$1" ]] || fail "missing required file: $1"
}

require_nonempty_file() {
  [[ -s "$1" ]] || fail "missing or empty required file: $1"
}

require_executable() {
  [[ -x "$1" ]] || fail "missing or non-executable required file: $1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      APP="$2"
      CUSTOM_APP=true
      shift 2
      ;;
    --skip-architecture-check)
      SKIP_ARCHITECTURE_CHECK=true
      shift
      ;;
    --fixture-skip-runtime-check)
      SKIP_RUNTIME_CHECK=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ "$SKIP_RUNTIME_CHECK" == true && "$CUSTOM_APP" == false ]]; then
  fail "--fixture-skip-runtime-check requires an explicit --app fixture path"
fi
if [[ "$SKIP_ARCHITECTURE_CHECK" == true && "$CUSTOM_APP" == false ]]; then
  fail "--skip-architecture-check requires an explicit --app fixture path"
fi

PLIST="$APP/Contents/Info.plist"
RESOURCES="$APP/Contents/Resources"
BACKEND="$RESOURCES/backend/call-assistant-backend"
ELECTRON="$APP/Contents/MacOS/Live Call Assistant"
BGE="$RESOURCES/models/bge-small-en-v1.5"
WHISPER="$RESOURCES/models/faster-whisper-small"
KNOWLEDGE="$RESOURCES/data/knowledge"

require_directory "$APP"
require_nonempty_file "$PLIST"
require_executable "$BACKEND"
require_nonempty_file "$BACKEND"
require_executable "$ELECTRON"
require_nonempty_file "$ELECTRON"
require_nonempty_file "$BGE/model.safetensors"
require_nonempty_file "$BGE/config.json"
require_nonempty_file "$BGE/tokenizer.json"
require_nonempty_file "$WHISPER/model.bin"
require_nonempty_file "$WHISPER/config.json"
require_nonempty_file "$WHISPER/tokenizer.json"
require_directory "$KNOWLEDGE"
if ! find "$KNOWLEDGE" -type f -name '*.md' -size +0c -print -quit | grep -q .; then
  fail "knowledge directory has no non-empty Markdown content: $KNOWLEDGE"
fi
require_nonempty_file "$RESOURCES/data/faiss_index/index.faiss"
require_nonempty_file "$RESOURCES/data/faiss_index/metadata.json"
require_nonempty_file "$RESOURCES/app.asar"

if [[ "$SKIP_ARCHITECTURE_CHECK" == false ]]; then
  file "$BACKEND" | grep -q 'arm64' || fail "backend executable is not arm64: $BACKEND"
  file "$ELECTRON" | grep -q 'arm64' || fail "Electron executable is not arm64: $ELECTRON"
fi

audio_usage="$(/usr/libexec/PlistBuddy -c 'Print :NSAudioCaptureUsageDescription' "$PLIST" 2>/dev/null || true)"
[[ -n "$audio_usage" ]] || fail "missing NSAudioCaptureUsageDescription in $PLIST"
screen_usage="$(/usr/libexec/PlistBuddy -c 'Print :NSScreenCaptureUsageDescription' "$PLIST" 2>/dev/null || true)"
[[ -n "$screen_usage" ]] || fail "missing NSScreenCaptureUsageDescription in $PLIST"

if [[ "$SKIP_RUNTIME_CHECK" == false ]]; then
  PYTHON="$PROJECT_ROOT/.venv/bin/python"
  if [[ ! -x "$PYTHON" ]]; then
    PYTHON="$(command -v python3 || true)"
  fi
  [[ -n "$PYTHON" && -x "$PYTHON" ]] || fail "Python 3 is required for the packaged backend smoke check"
  "$PYTHON" "$PROJECT_ROOT/scripts/smoke_packaged_backend.py" --app "$APP" \
    || fail "packaged backend offline health smoke failed"
fi

echo 'Mac bundle verification passed'
