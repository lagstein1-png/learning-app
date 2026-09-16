#!/usr/bin/env bash
# One-shot environment setup for the multilingual TTS learning backend.
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
"$PY" -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ required"'

if [ ! -d .venv ]; then
  "$PY" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install --upgrade pip >/dev/null
pip install -r requirements.txt

[ -f .env ] || cp .env.example .env
mkdir -p state

echo
echo "Environment ready."
echo "  source .venv/bin/activate"
echo "  pytest -q                      # offline test suite"
echo "  python main.py                 # end-to-end pipeline (Hebrew sample)"
echo "  python main.py --material en/photosynthesis.md --language en"
