#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON_VERSION="44.2.0"
ARCHIVE_NAME="electron-v${ELECTRON_VERSION}-darwin-arm64.zip"
ELECTRON_CACHE="$PROJECT_ROOT/.cache/electron"
ELECTRON_ARCHIVE="$ELECTRON_CACHE/$ARCHIVE_NAME"
ELECTRON_CHECKSUMS="$ELECTRON_CACHE/SHASUMS256.txt"
ELECTRON_RELEASE_URL="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}"

verify_electron_archive() {
  local expected_sha256
  expected_sha256="$(awk -v archive="$ARCHIVE_NAME" '$2 == archive || $2 == "*" archive { print $1; exit }' "$ELECTRON_CHECKSUMS")"
  test -n "$expected_sha256"
  printf '%s  %s\n' "$expected_sha256" "$ELECTRON_ARCHIVE" | shasum -a 256 -c -
}

mkdir -p "$ELECTRON_CACHE"
curl --fail --location --connect-timeout 30 --speed-limit 1024 --speed-time 60 \
  --retry 5 --retry-delay 2 --retry-all-errors \
  --output "$ELECTRON_CHECKSUMS" "$ELECTRON_RELEASE_URL/SHASUMS256.txt"
if ! verify_electron_archive; then
  curl --fail --location --connect-timeout 30 --speed-limit 1024 --speed-time 60 \
    --retry 5 --retry-delay 2 --retry-all-errors \
    --continue-at - --output "$ELECTRON_ARCHIVE" "$ELECTRON_RELEASE_URL/$ARCHIVE_NAME"
  verify_electron_archive
fi

bash "$PROJECT_ROOT/scripts/build-mac-backend.sh"
npm run build --prefix "$PROJECT_ROOT/frontend"
cd "$PROJECT_ROOT"
./node_modules/.bin/electron-builder --mac dir --arm64

SOURCE_APP="$PROJECT_ROOT/release/mac-arm64/Live Call Assistant.app"
TARGET_APP="$PROJECT_ROOT/release/Live Call Assistant.app"
test -d "$SOURCE_APP"
if [[ -d "$TARGET_APP" ]]; then
  BACKUP_APP="$PROJECT_ROOT/release/Live Call Assistant.$(date +%Y%m%d-%H%M%S).app"
  mv "$TARGET_APP" "$BACKUP_APP"
fi
ditto "$SOURCE_APP" "$TARGET_APP"
