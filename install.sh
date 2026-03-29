#!/bin/sh
set -e

REPO="Mojashi/claude-fulltext-search"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

# Detect platform
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="darwin" ;;
  Linux)  PLATFORM="linux" ;;
  *)      echo "Unsupported OS: $OS"; exit 1 ;;
esac

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)             echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

ASSET="claude-search-${PLATFORM}-${ARCH}"
echo "Downloading ${ASSET}..."

# Get latest release download URL
URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"

TMP="$(mktemp)"
if command -v curl >/dev/null 2>&1; then
  curl -fSL -o "$TMP" "$URL"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$TMP" "$URL"
else
  echo "Error: curl or wget is required"; exit 1
fi

chmod +x "$TMP"

# Install
if [ -w "$INSTALL_DIR" ]; then
  mv "$TMP" "${INSTALL_DIR}/claude-search"
else
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  sudo mv "$TMP" "${INSTALL_DIR}/claude-search"
fi

echo "claude-search installed to ${INSTALL_DIR}/claude-search"
echo "Run 'claude-search' to get started."
