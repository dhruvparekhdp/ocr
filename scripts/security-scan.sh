#!/usr/bin/env bash
# gitleaks + pip-audit. The app has no Python dependencies; requirements.txt
# is comments only so pip-audit fails closed if a package line appears and
# is vulnerable, and passes when the file stays empty of packages.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is not on PATH. CI installs v8.30.1; install the same release locally to run this scan." >&2
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "python3 is required to run pip-audit." >&2
  exit 1
fi

if ! "$PY" -c 'import pip_audit' >/dev/null 2>&1; then
  "$PY" -m pip install --user 'pip-audit==2.10.1'
fi

gitleaks detect --source "$ROOT" --redact --verbose
"$PY" -m pip_audit -r "$ROOT/requirements.txt"
