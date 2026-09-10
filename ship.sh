#!/usr/bin/env sh
# Build the image here and hand it to a host that cannot build one itself.
#
# The reason this exists rather than deploy.sh running on the server: the box
# this is aimed at is a 1 vCPU VPS with a few hundred megabytes free, running
# other things beside this one. `npm ci` and a docker build on it are slow at
# best and take the neighbours down at worst, so the build happens on a machine
# with room and only the finished image travels.
#
#   ./ship.sh root@host [/opt/finaltable]
#
# The host needs docker, a compose file naming `image: finaltable:latest`, and
# its own .env - none of which this script touches. Nothing secret is sent:
# the image carries no configuration, and the password and settings live in
# that .env on the far side.
set -eu

host="${1:-}"
dir="${2:-/opt/finaltable}"

if [ -z "$host" ]; then
  echo "usage: ./ship.sh user@host [remote-dir]" >&2
  exit 1
fi

cd "$(dirname "$0")"

if [ -n "$(git status --porcelain)" ]; then
  echo "ship: the working tree has changes; what lands there would not match a commit" >&2
  exit 1
fi

version="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "ship: building $version"
docker build -t finaltable:latest .

# gzip -1 rather than the default: the image is mostly incompressible layers
# already, and on a home upstream the difference in time is all in the transfer,
# not the compression.
echo "ship: sending the image to $host"
docker save finaltable:latest | gzip -1 | ssh "$host" 'gunzip | docker load'

echo "ship: recreating the container"
# up -d, not restart: restart would start the same container on the old image.
ssh "$host" "cd '$dir' && docker compose up -d"

echo "ship: waiting for it to answer"
ssh "$host" "cd '$dir' && cid=\$(docker compose ps -q finaltable) && \
  waited=0 && \
  while [ \"\$waited\" -lt 120 ]; do \
    health=\$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \"\$cid\"); \
    case \"\$health\" in \
      healthy) echo 'ship: healthy'; exit 0 ;; \
      unhealthy) echo 'ship: unhealthy' >&2; docker compose logs --tail 40 finaltable >&2; exit 1 ;; \
      none) echo 'ship: up (no healthcheck to confirm it)'; exit 0 ;; \
    esac; \
    waited=\$((waited + 2)); sleep 2; \
  done; \
  echo 'ship: never became healthy' >&2; exit 1"

echo "ship: $version is live on $host"
