#!/usr/bin/env bash
# Creates the Python runtime the OCR daemon needs and downloads its models.
#
# Kept as a script rather than an npm one-liner because the failure modes are
# distribution-specific and worth handling: several Linux distributions ship a
# python3 whose `venv` module cannot bootstrap pip (Debian and Ubuntu split it
# into a separate python3-venv package), which otherwise leaves a virtualenv
# that exists but has no pip in it, and an error message that does not say so.
set -euo pipefail

cd "$(dirname "$0")/.."
VENV=".venv"
PYTHON="${PYTHON3:-python3}"

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "python3 was not found on PATH."
  echo "  Debian/Ubuntu: sudo apt-get install -y python3 python3-venv"
  echo "  macOS:         brew install python"
  exit 1
fi
echo "Using $("$PYTHON" --version)"

if [ ! -d "$VENV" ]; then
  echo "Creating $VENV ..."
  # --without-pip succeeds where the pip bootstrap is unavailable; pip is then
  # installed explicitly below, which works on every distribution.
  "$PYTHON" -m venv "$VENV" 2>/dev/null || "$PYTHON" -m venv --without-pip "$VENV"
fi

VPY="$VENV/bin/python"
[ -x "$VPY" ] || { echo "Failed to create a virtualenv at $VENV"; exit 1; }

if ! "$VPY" -m pip --version >/dev/null 2>&1; then
  echo "The virtualenv has no pip; bootstrapping it ..."
  "$VPY" -m ensurepip --upgrade >/dev/null 2>&1 || {
    curl -sSL -o /tmp/get-pip.py https://bootstrap.pypa.io/get-pip.py
    "$VPY" /tmp/get-pip.py --quiet
    rm -f /tmp/get-pip.py
  }
fi
"$VPY" -m pip --version >/dev/null 2>&1 || { echo "Could not install pip into $VENV"; exit 1; }

echo "Installing the recognition runtime ..."
"$VPY" -m pip install --quiet --upgrade pip
"$VPY" -m pip install --quiet -r python/requirements.txt

echo "Downloading the PaddleOCR PP-OCRv5 models ..."
"$VPY" python/download_models.py ./models

echo "Verifying the models load ..."
"$VPY" - <<'PYCHECK'
import os
import onnxruntime as ort
for name in ("det.onnx", "cls.onnx", "rec_latin.onnx"):
    ort.InferenceSession(os.path.join("models", name), providers=["CPUExecutionProvider"])
print("  all three models load correctly")
PYCHECK

echo
echo "Done. Add this line to backend/.env so the server can find it:"
echo "  PYTHON_BIN=\"$(pwd)/$VENV/bin/python\""
