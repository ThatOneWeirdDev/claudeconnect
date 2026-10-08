#!/bin/sh
# ClaudeConnect: one-line install for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/ThatOneWeirdDev/claudeconnect/main/install.sh | sh
#
# It checks for Node.js, downloads the launcher (ClaudeConnect.mjs) and runs it. The launcher then downloads the current
# release, checks every file against the release manifest and runs setup. Anything after `sh -s --` is passed to setup:
#
#   curl -fsSL .../install.sh | sh -s -- --name "My Site"
#
# CLAUDECONNECT_REPO and CLAUDECONNECT_REF pick another source (a fork, a tag or a commit).
set -eu

REPO="${CLAUDECONNECT_REPO:-ThatOneWeirdDev/claudeconnect}"
REF="${CLAUDECONNECT_REF:-main}"
RAW="${CLAUDECONNECT_RAW:-https://raw.githubusercontent.com}"

say() { printf '%s\n' "$*" >&2; }

if ! command -v node >/dev/null 2>&1; then
  say "ClaudeConnect needs Node.js 22 or newer, and it isn't installed."
  say "Install the current LTS from https://nodejs.org, then run this again."
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$major" -lt 22 ]; then
  say "ClaudeConnect needs Node.js 22 or newer, and you have $(node --version)."
  say "Install the current LTS from https://nodejs.org, then run this again."
  exit 1
fi

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t claudeconnect)
trap 'rm -rf "$tmp"' EXIT INT TERM
url="$RAW/$REPO/$REF/ClaudeConnect.mjs"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$tmp/ClaudeConnect.mjs" || { say "Couldn't download $url"; exit 1; }
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp/ClaudeConnect.mjs" "$url" || { say "Couldn't download $url"; exit 1; }
else
  say "ClaudeConnect needs curl or wget to download itself. Install one, then run this again."
  exit 1
fi

# When this script is piped from curl, stdin is the script, not the keyboard. Setup asks questions, so hand it the real terminal.
status=0
if [ ! -t 0 ] && ( : </dev/tty ) 2>/dev/null; then
  node "$tmp/ClaudeConnect.mjs" "$@" </dev/tty || status=$?
else
  node "$tmp/ClaudeConnect.mjs" "$@" || status=$?
fi
exit "$status"
