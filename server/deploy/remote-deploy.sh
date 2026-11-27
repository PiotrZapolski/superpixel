#!/usr/bin/env bash
# Pull-based deploy, runs on the prod box as root.
# Triggered every 2 minutes by the systemd timer superpixel-deploy.timer
# (service: superpixel-deploy.service); it may also be run by hand.
# It fetches origin/master, and rebuilds the container only when server/ changed
# or the container is not running and healthy.
#
# Everything lives in main() so bash parses the whole script before running it;
# git reset below may rewrite this very file mid-run.
set -euo pipefail

main() {
    local repo=/var/www/superpixel
    local container=superpixel-log

    cd "$repo"
    git fetch --quiet origin master

    local old new
    old=$(git rev-parse HEAD)
    new=$(git rev-parse origin/master)

    container_status() {
        docker inspect -f '{{if .State.Running}}{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}{{else}}stopped{{end}}' "$container" 2>/dev/null || echo missing
    }

    # Tell search engines (IndexNow) about the sitemap URLs, once per version of server/site.
    # Also called from the early exits: the run that first ships this function still executes the
    # previous script, so the next timer tick catches up. One attempt, never fails the deploy.
    notify_indexnow() {
        local marker="$repo/.git/indexnow-site" site
        site=$(git -C "$repo" rev-parse HEAD:server/site) || return 0
        if [ "$(cat "$marker" 2>/dev/null)" = "$site" ]; then
            return 0
        fi
        echo "$site" > "$marker" || return 0
        timeout 60 docker exec "$container" python indexnow.py || echo "WARN: IndexNow submit failed" >&2
    }

    if [ "$old" = "$new" ] && [ "$(container_status)" = "healthy" ]; then
        notify_indexnow
        exit 0
    fi

    git reset --hard origin/master

    if [ "$old" != "$new" ] && git diff --quiet "$old" "$new" -- server/ && [ "$(container_status)" = "healthy" ]; then
        echo "no server changes"
        notify_indexnow
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
    notify_indexnow
}

main
exit 0
