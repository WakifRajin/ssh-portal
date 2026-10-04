#!/bin/sh
# SSH Portal bridge installer for macOS and Linux.
#   curl -fsSL https://<you>.github.io/<repo>/install.sh | sh -s <owner>/<repo>
# Downloads the standalone bridge from the repository's latest GitHub release,
# installs it for the current user (~/.ssh-portal/bin), starts it, and sets it
# to start at login. No root needed.
set -eu

REPO="${1:-${SSH_PORTAL_REPO:-}}"
if [ -z "$REPO" ]; then
  echo "usage: install.sh <owner>/<repo>" >&2
  exit 1
fi

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) echo "Unsupported OS: $(uname -s). Use the Windows installer or run the bridge with Node.js." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

url="https://github.com/$REPO/releases/latest/download/ssh-portal-bridge-$os-$arch"
tmp="$(mktemp "${TMPDIR:-/tmp}/ssh-portal-bridge.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

echo "Downloading SSH Portal bridge for $os-$arch…"
if command -v curl >/dev/null 2>&1; then
  curl -fL --progress-bar "$url" -o "$tmp"
else
  wget -q --show-progress -O "$tmp" "$url"
fi
chmod +x "$tmp"
[ "$os" = macos ] && xattr -d com.apple.quarantine "$tmp" 2>/dev/null || true

"$tmp" --install
