#!/usr/bin/env bash
# Rebuilds production when origin/main has a new commit. Meant for a dedicated clone that is used
# only for production (see README), run every minute by a systemd timer. Safe to run by hand.
set -euo pipefail
cd "$(dirname "$0")/.."

gitdir=$(git rev-parse --absolute-git-dir)
exec 9>"$gitdir/auto-deploy.lock"
flock -n 9 || exit 0

log() { printf '%s %s\n' "$(date -Is)" "$*"; }
state="$gitdir/auto-deploy-last"   # the commit that was last built successfully

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "refusing to deploy: this clone has local changes"
  exit 1
fi

git fetch --quiet origin main
# Production-only clone, so follow origin/main even if it was rewritten or rolled back.
git reset --quiet --hard origin/main
head=$(git rev-parse HEAD)
last=$(cat "$state" 2>/dev/null || true)
if [ "$head" = "$last" ]; then
  exit 0
fi

log "deploying $(git rev-parse --short "$head")"
cd deploy

# The API runs `alembic upgrade head` when it starts, so take a fresh dump first whenever the
# migrations changed (or there is no record of the last build). If it fails, nothing is deployed.
if [ -z "$last" ] || ! git cat-file -e "$last^{commit}" 2>/dev/null \
   || ! git diff --quiet "$last" "$head" -- ../apps/api/migrations; then
  if docker compose ps --status running --services 2>/dev/null | grep -qx db; then
    log "migrations changed: backing up the database first"
    if ! ./backup.sh >/dev/null; then
      log "backup FAILED; not deploying $(git rev-parse --short "$head")"
      exit 1
    fi
  else
    log "database not running (first deploy?): skipping the backup"
  fi
fi

if docker compose up -d --build --remove-orphans; then
  echo "$head" > "$state"
  docker image prune -f >/dev/null || true
  log "deployed $(git rev-parse --short "$head")"
else
  log "deploy FAILED for $(git rev-parse --short "$head"); retrying next run"
  exit 1
fi
