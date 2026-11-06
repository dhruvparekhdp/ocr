#!/usr/bin/env bash
# One-command dev setup: system packages the fixture tests and CI expect,
# then npm ci. Does not read or write secrets.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

need_apt=()
if ! command -v tesseract >/dev/null 2>&1; then
  need_apt+=(tesseract-ocr)
fi
if ! command -v pdftotext >/dev/null 2>&1; then
  need_apt+=(poppler-utils)
fi
if [[ ! -f /usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf && ! -f /usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf ]]; then
  need_apt+=(fonts-liberation)
fi
# pip-audit builds a temporary virtualenv. Without this package it crashes
# before it can report a result.
if command -v python3 >/dev/null 2>&1 && ! python3 -c 'import ensurepip' >/dev/null 2>&1; then
  need_apt+=(python3-venv)
fi

if ((${#need_apt[@]} > 0)); then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Missing packages: ${need_apt[*]}" >&2
    echo "Install tesseract-ocr, poppler-utils, and fonts-liberation with your OS package manager, then re-run." >&2
    exit 1
  fi
  sudo apt-get update
  sudo apt-get install -y "${need_apt[@]}"
fi

npm ci
