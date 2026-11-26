#!/usr/bin/env bash
# Deploy from CT 111 (agents-hub). Linux twin of deploy.ps1.
# Usage: ./deploy.sh [--no-snapshot]           arcade client -> CT 112 /var/www/arcade  (homelab-deploy arcade-2077)
#        ./deploy.sh --server [--no-snapshot]  WILDCARD server -> CT 113 /opt/wildcard-server (homelab-deploy wildcard-server)
# The client deploy runs npm test and never ships the game server folder, deploy.* or tests (see homelab-deploy).
set -euo pipefail
SELF=$(readlink -f "$0")
cd "$(dirname "$SELF")"

target=arcade-2077
args=()
for a in "$@"; do
  case "$a" in
    -h|--help) sed -n '2,5p' "$SELF"; exit 0 ;;
    --server) target=wildcard-server ;;
    *) args+=("$a") ;;
  esac
done

if [[ ! -x /usr/local/bin/homelab-deploy ]]; then
  echo "homelab-deploy not found: run this on CT 111 (agents-hub), or use deploy.ps1." >&2
  exit 1
fi
exec /usr/local/bin/homelab-deploy "$target" "${args[@]}"
