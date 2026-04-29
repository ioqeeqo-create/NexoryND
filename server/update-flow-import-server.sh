#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/flow}"
BRANCH="${BRANCH:-cursor/liquid-glass-room-widget-0756}"
SERVICE_NAME="${SERVICE_NAME:-flow-import-server}"

if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "ERROR: $APP_DIR is not a git repo"
  exit 1
fi

echo "[1/6] Entering $APP_DIR"
cd "$APP_DIR"

echo "[2/6] Fetching latest changes"
git fetch --all --prune

echo "[3/6] Switching to branch: $BRANCH"
git checkout "$BRANCH"

echo "[4/6] Pulling latest commit"
git pull --ff-only origin "$BRANCH"

echo "[5/6] Installing dependencies"
npm ci

echo "[6/6] Restarting pm2 service: $SERVICE_NAME"
pm2 restart "$SERVICE_NAME"
pm2 save

echo "Done. Current commit:"
git log -1 --oneline
echo
echo "Health check:"
curl -fsS "http://127.0.0.1:8787/health" || true
