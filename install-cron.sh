#!/usr/bin/env bash
# install-cron.sh — install the Aegis nightly cron job.
#
# Usage:
#   ./install-cron.sh                # install with default schedule (02:00 daily)
#   ./install-cron.sh "0 4 * * 0"    # install with custom schedule
#   ./install-cron.sh --uninstall    # remove the cron job
#   ./install-cron.sh --show         # show current cron entry
set -euo pipefail

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$(command -v node)"
SCHEDULE="${1:-0 2 * * *}"
MARK="# Aegis"

usage() {
  sed -n '2,12p' "$0"
  exit 1
}

[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && usage

if [[ "${1:-}" == "--uninstall" ]]; then
  if crontab -l 2>/dev/null | grep -qF "$MARK"; then
    crontab -l | grep -vF "$MARK" | crontab -
    echo "Removed Aegis cron job."
  else
    echo "No Aegis cron job found."
  fi
  exit 0
fi

if [[ "${1:-}" == "--show" ]]; then
  crontab -l 2>/dev/null | grep -F "$MARK" || echo "(no Aegis cron job installed)"
  exit 0
fi

if [[ -z "${NODE_BIN}" ]]; then
  echo "node not found in PATH" >&2
  exit 2
fi

if ! crontab -l 2>/dev/null | grep -qF "$MARK"; then
  ( crontab -l 2>/dev/null || true; \
    printf '\n%s %s %s %s >> /var/log/aegis.cron.log 2>&1\n' \
      "$SCHEDULE" "$NODE_BIN" "$TOOL_DIR/backup.mjs" "$MARK" ) | crontab -
  echo "Installed Aegis cron job: '$SCHEDULE'"
else
  echo "Aegis cron job already present (use --uninstall first to change)."
fi
echo "Cron entries:"
crontab -l | grep -F "$MARK" || true
