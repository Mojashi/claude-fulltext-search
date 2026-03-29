#!/bin/sh
set -e

REPO="Mojashi/claude-fulltext-search"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

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

# Ensure install directory exists
mkdir -p "$INSTALL_DIR"
mv "$TMP" "${INSTALL_DIR}/claude-search"

echo "claude-search installed to ${INSTALL_DIR}/claude-search"

# Check if install dir is in PATH
case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo ""
    echo "Add ${INSTALL_DIR} to your PATH:"
    echo ""
    echo "  echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ~/.zshrc"
    echo ""
    ;;
esac
