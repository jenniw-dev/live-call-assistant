#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="$PROJECT_ROOT/.venv/bin/python"
LOCK="$PROJECT_ROOT/backend/requirements-macos-arm64.lock"

"$PYTHON" -m pip install --disable-pip-version-check --no-deps --require-hashes --requirement "$LOCK"
"$PYTHON" "$PROJECT_ROOT/scripts/verify_python_lock.py" --lock "$LOCK"
"$PYTHON" "$PROJECT_ROOT/scripts/download-models.py"
cd "$PROJECT_ROOT/backend"
"$PROJECT_ROOT/.venv/bin/pyinstaller" --noconfirm --clean call_assistant_backend.spec
file dist/call-assistant-backend/call-assistant-backend
