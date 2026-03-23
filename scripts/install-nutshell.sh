#!/usr/bin/env bash

set -euo pipefail

NUTSHEL_VERSION="0.19.2"
NUTSHEL_ZIP="nutshell-${NUTSHEL_VERSION}.zip"
NUTSHEL_URL="https://github.com/cashubtc/nutshell/archive/refs/tags/${NUTSHEL_VERSION}.zip"
NUTSHEL_DIR="/tmp/nutshell-${NUTSHEL_VERSION}"

echo "============================================"
echo " Installing Nutshell"
echo "============================================"

# Download Nutshell source
echo "Downloading Nutshell from ${NUTSHEL_URL}..."
curl -L -o "/tmp/${NUTSHEL_ZIP}" "${NUTSHEL_URL}"

# Unzip to /tmp
echo "Unzipping to ${NUTSHEL_DIR}..."
unzip -q "/tmp/${NUTSHEL_ZIP}" -d /tmp/

# Install Cashu (Nutshell)
echo "Uninstalling existing Cashu package (if any)..."
pip uninstall -y cashu || true

echo "Installing Cashu Python package in editable mode..."
cd "${NUTSHEL_DIR}"
pip install -e .
pip uninstall -y marshmallow || true
pip install marshmallow==3.12.2
pip install nostr-sdk

echo "============================================"
echo " Nutshell Installation Complete!"
echo "============================================"
echo "You can now run 'cashu' from your terminal."
