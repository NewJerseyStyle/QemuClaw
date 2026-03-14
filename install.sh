#!/usr/bin/env bash
# QemuClaw quick installer for Linux (Debian/Ubuntu)
# Usage: curl -fsSL https://raw.githubusercontent.com/NewJerseyStyle/QemuClaw/main/install.sh | bash
set -euo pipefail

REPO="NewJerseyStyle/QemuClaw"

info()  { printf '\033[1;34m[info]\033[0m  %s\n' "$*"; }
ok()    { printf '\033[1;32m[ok]\033[0m    %s\n' "$*"; }
err()   { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }

# --- Pre-flight checks -------------------------------------------------------

if [ "$(uname -s)" != "Linux" ]; then
  err "This script only supports Linux."
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  err "apt-get not found. This installer supports Debian/Ubuntu-based distros only."
  exit 1
fi

# --- Install dependencies ----------------------------------------------------

info "Installing QEMU and dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq qemu-system-x86 wget curl > /dev/null
ok "Dependencies installed."

# --- Fetch latest release info ------------------------------------------------

info "Fetching latest QemuClaw release..."
RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=20")

# Find the latest app-v* release (skip VM image releases tagged vm-*)
DEB_URL=$(echo "$RELEASE_JSON" \
  | grep -oP '"browser_download_url":\s*"\K[^"]*linux\.deb' \
  | head -1)

if [ -z "$DEB_URL" ]; then
  err "Could not find a .deb download in the latest releases."
  err "Visit https://github.com/${REPO}/releases to download manually."
  exit 1
fi

DEB_FILE=$(basename "$DEB_URL")
info "Downloading ${DEB_FILE}..."

# --- Download and install .deb ------------------------------------------------

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

wget -q --show-progress -O "${TMPDIR}/${DEB_FILE}" "$DEB_URL"
ok "Download complete."

info "Installing ${DEB_FILE}..."
sudo dpkg -i "${TMPDIR}/${DEB_FILE}" || true
# Fix any missing dependencies dpkg might flag
sudo apt-get install -f -y -qq > /dev/null
ok "QemuClaw installed."

# --- Verify -------------------------------------------------------------------

if command -v qemuclaw >/dev/null 2>&1 || [ -f /usr/bin/qemuclaw ] || [ -f /opt/QemuClaw*/qemuclaw ]; then
  ok "Installation successful! Launch QemuClaw from your application menu or run: qemuclaw"
else
  # electron-builder .deb installs to /opt by default
  INSTALLED=$(dpkg -L qemuclaw 2>/dev/null | grep -m1 'qemuclaw$' || true)
  if [ -n "$INSTALLED" ]; then
    ok "Installation successful! Run: ${INSTALLED}"
  else
    ok "Package installed. Launch QemuClaw from your application menu."
  fi
fi
