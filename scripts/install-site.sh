#!/usr/bin/env bash
#
# install-site — publish trust.json and security.txt to the web root.
#
# IDEMPOTENT BY DESIGN. It compares sha256 FIRST and does nothing when the
# content already matches — no copy, no backup, no reload. A "backup" taken on
# every run is not a backup; it is a directory that fills with identical files
# until somebody deletes the one that mattered.
#
# Why a dedicated root and not the application's public/ directory:
#   - public/ is copied into .next/standalone/ by every deploy, so a file placed
#     there is regenerated on each release;
#   - the application tree belongs to another delivery lane.
# These two files must survive both, so nginx serves them from here via two
# exact-match locations.
#
# Usage: install-site.sh [--dry-run]

set -euo pipefail

ROOT="${INA_TRUST_WEB_ROOT:-/var/www/inagpt-trust}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/build"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

TS="$(date -u +%Y%m%dT%H%M%SZ)"
changed=0

install_one() {
  local src="$1" dest="$2"
  [ -f "$src" ] || { echo "install-site: FATAL missing $src — run 'make trust' first" >&2; exit 2; }
  mkdir -p "$(dirname "$dest")"

  if [ -f "$dest" ] && [ "$(sha256sum "$src" | cut -d' ' -f1)" = "$(sha256sum "$dest" | cut -d' ' -f1)" ]; then
    printf '  unchanged  %s\n' "$dest"
    return 0
  fi

  if [ "$DRY" = "1" ]; then
    printf '  WOULD WRITE %s\n' "$dest"
    changed=$((changed + 1))
    return 0
  fi

  if [ -f "$dest" ]; then
    cp -p "$dest" "$dest.bak-$TS"
    printf '  backed up  %s\n' "$dest.bak-$TS"
  fi
  cp "$src" "$dest"
  chmod 644 "$dest"
  printf '  installed  %s\n' "$dest"
  changed=$((changed + 1))
}

install_one "$SRC/trust.json"   "$ROOT/trust.json"
install_one "$SRC/marks.json"   "$ROOT/marks.json"
install_one "$SRC/security.txt" "$ROOT/.well-known/security.txt"

# The web application consumes marks.json at BUILD time, so it needs the file
# inside its own tree — a runtime fetch would make the footer depend on a
# network call, and a build-time import makes an unsanctioned mark a build
# failure instead of a live one.
APP_SOURCES="${INA_APP_SOURCES:-/root/inagpt/public/badges/SOURCES.json}"
if [ -d "$(dirname "$APP_SOURCES")" ]; then
  install_one "$SRC/sources.json" "$APP_SOURCES"
fi

APP_MARKS="${INA_APP_MARKS:-/root/inagpt/src/lib/trust/marks.generated.json}"
if [ -d "$(dirname "$APP_MARKS")" ]; then
  install_one "$SRC/marks.json" "$APP_MARKS"
else
  echo "  skipped    $APP_MARKS (application tree not present here)"
fi

if [ "$changed" -eq 0 ]; then
  echo "install-site: OK — already current, nothing written, no backup created"
  exit 0
fi

if [ "$DRY" = "1" ]; then
  echo "install-site: --dry-run — $changed file(s) would change"
  exit 0
fi

# Content changed, so the served bytes changed. nginx serves these from disk via
# alias, so no reload is needed for content — only if the LOCATION rules change.
echo "install-site: $changed file(s) installed (nginx serves them from disk; no reload needed for a content change)"
