#!/usr/bin/env bash
# install-cron.sh — install the Aegis nightly cron job (and optional weekly verify).
#
# Usage:
#   ./install-cron.sh                     # install backup cron with default schedule (02:00 daily)
#   ./install-cron.sh "0 4 * * 0"         # install backup cron with custom schedule
#   ./install-cron.sh --verify            # also install weekly verify cron (Sun 06:00)
#   ./install-cron.sh --verify "30 6 * * 0"   # weekly verify with custom schedule
#   ./install-cron.sh --uninstall         # remove ALL Aegis cron jobs (backup + verify)
#   ./install-cron.sh --show              # show current Aegis cron entries
set -euo pipefail

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$(command -v node)"
SCHEDULE="${1:-0 2 * * *}"
VERIFY_SCHEDULE="${VERIFY_SCHEDULE:-0 6 * * 0}"
MARK="# aegis"
VERIFY_MARK="# aegis-verify"

usage() {
  sed -n '2,15p' "$0"
  exit 1
}

[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && usage

# Parse flags.
DO_VERIFY=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --verify) DO_VERIFY=1 ;;
    --verify=*) VERIFY_SCHEDULE="${arg#--verify=}"; DO_VERIFY=1 ;;
    --verify-schedule) shift; VERIFY_SCHEDULE="${1:-0 6 * * 0}"; DO_VERIFY=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done
# Re-pick positional schedule if first arg isn't a flag.
if [[ ${#ARGS[@]} -gt 0 && "${ARGS[0]}" != --* ]]; then
  SCHEDULE="${ARGS[0]}"
fi

if [[ "${1:-}" == "--uninstall" ]]; then
  removed=0
  for m in "$MARK" "$VERIFY_MARK"; do
    if crontab -l 2>/dev/null | grep -qF "$m"; then
      crontab -l | grep -vF "$m" | crontab -
      echo "Removed cron entries with mark '$m'."
      removed=1
    fi
  done
  [[ $removed -eq 0 ]] && echo "No Aegis cron jobs found."
  exit 0
fi

if [[ "${1:-}" == "--show" ]]; then
  found=0
  for m in "$MARK" "$VERIFY_MARK"; do
    if crontab -l 2>/dev/null | grep -qF "$m"; then
      crontab -l | grep -F "$m"
      found=1
    fi
  done
  [[ $found -eq 0 ]] && echo "(no Aegis cron jobs installed)"
  exit 0
fi

if [[ -z "${NODE_BIN}" ]]; then
  echo "node not found in PATH" >&2
  exit 2
fi

# Install backup cron.
if ! crontab -l 2>/dev/null | grep -qF "$MARK"; then
  ( crontab -l 2>/dev/null || true; \
    printf '\n%s %s %s %s >> /var/log/aegis.cron.log 2>&1\n' \
      "$SCHEDULE" "$NODE_BIN" "$TOOL_DIR/aegis.mjs" "$MARK" ) | crontab -
  echo "Installed Aegis backup cron: '$SCHEDULE'"
else
  echo "Aegis backup cron already present (use --uninstall first to change)."
fi

# Optionally install weekly verify cron.
if [[ $DO_VERIFY -eq 1 ]]; then
  if ! crontab -l 2>/dev/null | grep -qF "$VERIFY_MARK"; then
    ( crontab -l 2>/dev/null || true; \
      printf '\n%s %s %s/restore.mjs --verify-latest --yes >> /var/log/aegis.verify.log 2>&1 %s\n' \
        "$VERIFY_SCHEDULE" "$NODE_BIN" "$TOOL_DIR" "$VERIFY_MARK" ) | crontab -
    echo "Installed Aegis weekly verify cron: '$VERIFY_SCHEDULE'"
  else
    echo "Aegis verify cron already present."
  fi
fi

echo "Cron entries:"
crontab -l | grep -F "$MARK" || true
