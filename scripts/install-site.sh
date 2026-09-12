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

# ── REACHABILITY ────────────────────────────────────────────────────────────
# Installing a file and SERVING it are two different facts, and this script
# only ever established the first.
#
# Measured 2026-09-12: sources.json sat in /var/www/inagpt-trust/ returning 404
# for its entire life, because every register file is published through an
# EXACT `location =` block in the nginx site and nobody had added one. The
# install printed "installed" and was telling the truth about the wrong thing.
#
# It runs on EVERY terminal path, not only after a write. The first version of
# this check sat below the "already current, nothing written" early exit — and
# that is precisely the state the 404 lived in: installed once, unchanged
# forever, never served. A check the common path skips is not a check.
#
# WARN, never fail: this script legitimately runs on a host with no public
# route yet. But "could not check" is printed as itself, never folded into
# success.
_reachability() {
  local BASE="${INA_TRUST_PUBLIC_BASE:-https://inagpt.com}"
  if ! command -v curl >/dev/null 2>&1; then
    echo "install-site: reachability UNKNOWN — no curl on this host. Not a pass."
    return 0
  fi
  local unreachable=0 served=0 unknown=0 code
  for path in /trust.json /marks.json /sources.json /.well-known/security.txt; do
    # NOT `$(curl … || echo 000)`: on a refused connection curl PRINTS 000 and
    # ALSO exits non-zero, so the fallback appended a second value and the
    # capture became "000\n000" — matching neither the 000 arm nor 200, and
    # landing in the catch-all as "HTTP 000000". That reported an offline probe
    # as "nothing serves them", which is the one confusion this arm exists to
    # prevent: "could not check" and "checked, and it is broken" are different
    # verdicts.
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
      -A 'Mozilla/5.0 (install-site reachability probe)' "$BASE$path") || true
    [ -n "$code" ] || code=000
    case "$code" in
      200) served=$((served + 1)) ;;
      000) echo "install-site: reachability UNKNOWN for $path — the probe itself could not run (offline?). Not a pass."
           unknown=$((unknown + 1)) ;;
      *)   echo "install-site: UNREACHABLE $BASE$path -> HTTP $code. The bytes are on disk; nothing serves them."
           echo "              Add an exact location to the nginx site:"
           echo "                  location = $path { alias ${ROOT}${path}; default_type application/json; }"
           echo "              then: nginx -t && systemctl reload nginx"
           unreachable=$((unreachable + 1)) ;;
    esac
  done
  if [ "$unreachable" -gt 0 ]; then
    echo "install-site: $unreachable published file(s) are NOT SERVED — see above."
  elif [ "$unknown" -gt 0 ]; then
    echo "install-site: reachability PARTIAL — $served/4 answered 200, $unknown unprovable."
  else
    echo "install-site: reachability OK — $served/4 register surface(s) answer 200 at $BASE"
  fi
}

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
install_one "$SRC/sources.json" "$ROOT/sources.json"
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
  _reachability
  exit 0
fi

if [ "$DRY" = "1" ]; then
  echo "install-site: --dry-run — $changed file(s) would change"
  exit 0
fi

# Content changed, so the served bytes changed. nginx serves these from disk via
# alias, so no reload is needed for content — only if the LOCATION rules change.
echo "install-site: $changed file(s) installed (nginx serves them from disk; no reload needed for a content change)"
_reachability
