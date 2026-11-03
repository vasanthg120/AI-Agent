#!/usr/bin/env bash
# Deploys one tested build on the EC2 server, checks it is healthy, and puts the
# previous build back if it is not.
#
#   ./deploy.sh <git-sha>   build that commit's images (if not built yet) and run them (what GitHub Actions runs)
#   ./deploy.sh rollback    go back to the build that ran before the current one
#   ./deploy.sh status      show what is deployed and whether it is healthy
#
# Runs in /var/www/AI-Agent as the deploy user (a member of the docker group).
set -euo pipefail

APP_DIR="/var/www/AI-Agent"
STATE_DIR="$APP_DIR/.deploy"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)
APP_SERVICES=(python-agent backend frontend)
KEEP_IMAGES=5

cd "$APP_DIR"
mkdir -p "$STATE_DIR"
# VITE_API_URL, VITE_SOCKET_URL, BACKUP_BUCKET (never committed; see deploy/env/server.env.example).
if [ -f .env ]; then set -a; . ./.env; set +a; fi

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

healthy() {
  # Each service answers on its own local port (docker-compose.prod.yml binds them to 127.0.0.1).
  local tries=0
  until curl -fsS -m 5 http://127.0.0.1:3000/health >/dev/null \
    && curl -fsS -m 5 http://127.0.0.1:8000/health >/dev/null \
    && curl -fsS -m 5 http://127.0.0.1:5173/ >/dev/null; do
    tries=$((tries + 1))
    # The AI service loads its embedding model on start: give it up to 3 minutes.
    if [ "$tries" -ge 36 ]; then return 1; fi
    sleep 5
  done
}

have_images() {
  local tag="$1"
  for service in "${APP_SERVICES[@]}"; do
    docker image inspect "haive/$service:$tag" >/dev/null 2>&1 || return 1
  done
}

run_tag() {
  local tag="$1"
  # A rollback reuses the images kept on the server; a new commit is built once (with Docker's cache,
  # only what changed is rebuilt). The running containers keep serving while it builds.
  if have_images "$tag"; then
    log "Images for $tag are already on this server."
  else
    [ -n "${VITE_API_URL:-}" ] || { log "VITE_API_URL is not set in $APP_DIR/.env — the frontend would call localhost."; exit 1; }
    log "Building images for $tag…"
    IMAGE_TAG="$tag" "${COMPOSE[@]}" build "${APP_SERVICES[@]}"
  fi
  log "Starting services…"
  IMAGE_TAG="$tag" "${COMPOSE[@]}" up -d --no-build --remove-orphans
}

case "${1:-}" in
  status)
    echo "Deployed: $(cat "$STATE_DIR/current" 2>/dev/null || echo none)   previous: $(cat "$STATE_DIR/previous" 2>/dev/null || echo none)"
    "${COMPOSE[@]}" ps
    healthy && echo "Healthy" || echo "NOT healthy"
    exit 0
    ;;
  rollback)
    target="$(cat "$STATE_DIR/previous" 2>/dev/null || true)"
    [ -n "$target" ] || { echo "No previous deployment recorded."; exit 1; }
    ;;
  "")
    echo "Usage: ./deploy.sh <git-sha> | rollback | status"; exit 1
    ;;
  *)
    target="$1"
    ;;
esac

current="$(cat "$STATE_DIR/current" 2>/dev/null || true)"
log "Deploying $target (running now: ${current:-nothing})"
run_tag "$target"

if healthy; then
  if [ "$target" != "$current" ]; then
    [ -n "$current" ] && echo "$current" > "$STATE_DIR/previous"
    echo "$target" > "$STATE_DIR/current"
  fi
  echo "$(date -u +%FT%TZ) $target ok" >> "$STATE_DIR/history.log"
  log "Healthy. $target is live."
  # Keep the last few builds of each image (for rollbacks); drop older ones and old build cache.
  for service in "${APP_SERVICES[@]}"; do
    docker images "haive/$service" --format '{{.CreatedAt}}	{{.Repository}}:{{.Tag}}' | sort -r | tail -n +$((KEEP_IMAGES + 1)) | cut -f2 | xargs -r docker rmi >/dev/null 2>&1 || true
  done
  docker image prune -f >/dev/null 2>&1 || true
  docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
  exit 0
fi

echo "$(date -u +%FT%TZ) $target FAILED" >> "$STATE_DIR/history.log"
log "Health check failed for $target. Recent logs:"
"${COMPOSE[@]}" logs --tail 40 backend python-agent || true
if [ -n "$current" ] && [ "$current" != "$target" ]; then
  log "Rolling back to $current…"
  run_tag "$current"
  if healthy; then log "Rolled back to $current."; else log "Rollback is not healthy either — check the logs."; fi
fi
exit 1
