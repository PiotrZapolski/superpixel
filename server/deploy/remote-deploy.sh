#!/usr/bin/env bash
# Runs on the prod box as the SSH forced command for the superpixel deploy key.
# Arguments and SSH_ORIGINAL_COMMAND are ignored on purpose: nothing sent by
# the client is ever executed.
#
# Everything lives in main() so bash parses the whole script before running it;
# git reset below may rewrite this very file mid-run.
set -euo pipefail

main() {
    local repo=/var/www/superpixel
    local container=superpixel-log

    cd "$repo"
    git fetch --quiet origin main
    git reset --hard origin/main

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
    docker image prune -f >/dev/null || true

    if [ "$status" != "healthy" ]; then
        docker logs --tail 50 "$container" >&2 || true
        exit 1
    fi
    echo "deployed $(git rev-parse --short HEAD)"
}

unset SSH_ORIGINAL_COMMAND
main
exit 0
