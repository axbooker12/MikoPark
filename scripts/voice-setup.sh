#!/usr/bin/env bash
# One-time install of MikoPark's local voice engine (Chatterbox) into voice-engine/.venv.
# Chatterbox needs Python 3.11. The first time the engine starts it downloads the model (a few GB).
set -euo pipefail
cd "$(dirname "$0")/../voice-engine"

if [ -d .venv ]; then
  echo "Voice engine is already installed (voice-engine/.venv). Delete that folder to reinstall."
  exit 0
fi

if command -v uv >/dev/null 2>&1; then
  echo "Creating a Python 3.11 environment with uv…"
  uv venv --python 3.11 .venv
  uv pip install --python .venv/bin/python -r requirements.txt
elif command -v python3.11 >/dev/null 2>&1; then
  echo "Creating a Python 3.11 environment…"
  python3.11 -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install -r requirements.txt
else
  echo "The voice engine needs Python 3.11, which wasn't found."
  echo "Install it with Homebrew, then run this again:"
  echo "    brew install python@3.11"
  echo "(Or install uv: brew install uv — it downloads Python 3.11 for you.)"
  exit 1
fi

echo
echo "Voice engine installed. It starts automatically with 'npm run dev'."
echo "The first start downloads the voice model, which can take a few minutes."
