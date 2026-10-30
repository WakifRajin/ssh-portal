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

fail() {
  printf '\n%s\n' "$*" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) fail "Unsupported OS: $(uname -s). Use the Windows installer, or run the bridge from source with Node.js." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  armv7l | armv6l | armhf)
    fail "This is a 32-bit ARM system ($(uname -m)). The standalone bridge needs 64-bit (e.g. 64-bit Raspberry Pi OS). You can still run it from source with Node.js: see the README." ;;
  *) fail "Unsupported CPU: $(uname -m). Run the bridge from source with Node.js instead (see the README)." ;;
esac

# The prebuilt bridge needs glibc; Alpine and other musl systems can't run it.
if [ "$os" = linux ] && { ldd --version 2>&1 | grep -qi musl || [ -e /etc/alpine-release ]; }; then
  fail "This system uses musl libc (e.g. Alpine), which the prebuilt bridge doesn't support. Run it from source with Node.js instead: see the README."
fi

# Download into the install folder rather than /tmp: some systems mount /tmp
# noexec, which would stop the downloaded program from running.
dir="$HOME/.ssh-portal/bin"
mkdir -p "$dir"
tmp="$dir/ssh-portal-bridge.download"
trap 'rm -f "$tmp"' EXIT

url="https://github.com/$REPO/releases/latest/download/ssh-portal-bridge-$os-$arch"
echo "Downloading SSH Portal bridge for $os-$arch…"
status=0
if command -v curl >/dev/null 2>&1; then
  code=$(curl -SL --progress-bar -w '%{http_code}' -o "$tmp" "$url") || status=$?
elif command -v wget >/dev/null 2>&1; then
  # plain flags only: BusyBox / old wget lack --show-progress
  wget -q -O "$tmp" "$url" || status=$?
  code=$([ "$status" = 0 ] && echo 200 || echo 000)
else
  fail "Neither curl nor wget is installed. Install one (e.g. sudo apt install curl) and run this again."
fi

if [ "$status" != 0 ] || [ "${code:-000}" != 200 ] || [ ! -s "$tmp" ]; then
  if [ "${code:-}" = 404 ]; then
    fail "The bridge download wasn't found ($url).
Either the repository $REPO is private (release downloads only work for public repositories),
or no release has been published yet (run the \"Release bridge\" workflow in the repository's Actions tab)."
  fi
  fail "Couldn't download the bridge from $url (HTTP ${code:-error}). Check your internet connection and try again."
fi

chmod +x "$tmp"
[ "$os" = macos ] && xattr -d com.apple.quarantine "$tmp" 2>/dev/null || true

"$tmp" --install
