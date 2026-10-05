#!/usr/bin/env bash
# Pull-based deploy, runs on the prod box as root.
# Triggered every 2 minutes by the systemd timer superpixel-deploy.timer
# (service: superpixel-deploy.service); it may also be run by hand.
# It fetches origin/main, and rebuilds the container only when server/ changed
# or the container is not running and healthy.
#
# Everything lives in main() so bash parses the whole script before running it;
# git reset below may rewrite this very file mid-run.
set -euo pipefail

main() {
    local repo=/var/www/superpixel
    local container=superpixel-log

    cd "$repo"
    git fetch --quiet origin main

    local old new
    old=$(git rev-parse HEAD)
    new=$(git rev-parse origin/main)

    container_status() {
        docker inspect -f '{{if .State.Running}}{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}{{else}}stopped{{end}}' "$container" 2>/dev/null || echo missing
    }

    if [ "$old" = "$new" ] && [ "$(container_status)" = "healthy" ]; then
        exit 0
    fi

    git reset --hard origin/main

    if [ "$old" != "$new" ] && git diff --quiet "$old" "$new" -- server/ && [ "$(container_status)" = "healthy" ]; then
        echo "no server changes"
        exit 0
    fi

    cd server
    if [ ! -f .env ]; then
        echo "ERROR: $repo/server/.env is missing. Create it from .env.example (chmod 600) and deploy again." >&2
        exit 1
    fi

    docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

    local status=unknown
    for _ in $(seq 1 15); do
        status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || echo missing)
        if [ "$status" = "healthy" ]; then
            break
        fi
        sleep 2
    done

    echo "$container health: $status"

    if [ "$status" != "healthy" ]; then
        docker logs --tail 50 "$container" >&2 || true
        exit 1
    fi
    echo "deployed $(git rev-parse --short HEAD)"
}

main
exit 0
