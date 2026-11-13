#!/usr/bin/env bash
# Regenerates the generated parts of docs/ from the current working tree:
#   examples  -> docs/example-outputs.pdf   (generate-examples.js)
#   guide     -> docs/guide/*.png           (generate-guide-screenshots.js, used by USER_GUIDE.md)
# Usage: docs/tools/generate-docs.sh [all|examples|guide]   (default: all)
# Needs Docker only: builds a throwaway image of this checkout, runs it on a private network
# with an in-memory database, drives it with the official Playwright image, then cleans up.
set -euo pipefail
cd "$(dirname "$0")/../.."
WHAT=${1:-all}
case "$WHAT" in all|examples|guide) ;; *) echo "usage: $0 [all|examples|guide]" >&2; exit 2;; esac
PW_IMAGE=mcr.microsoft.com/playwright:v1.49.1-noble
NET=cs-docs-$$
APP=cs-docs-app-$$
ADMIN_USERNAME=admin
ADMIN_PASSWORD=examples-not-used
WORK=$(mktemp -d)
cleanup() {
  docker rm -f "$APP" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker rmi -f clayscorer:docs >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

docker build -q -t clayscorer:docs . >/dev/null
docker network create "$NET" >/dev/null
docker run -d --name "$APP" --network "$NET" --user 1000:1000 --tmpfs /data:uid=1000,gid=1000 \
  -e ADMIN_USERNAME="$ADMIN_USERNAME" -e ADMIN_PASSWORD="$ADMIN_PASSWORD" clayscorer:docs >/dev/null
sleep 3

cp docs/tools/generate-examples.js docs/tools/generate-guide-screenshots.js "$WORK/"
# Run as the calling user so the work folder (node_modules etc.) can be cleaned up afterwards.
docker run --rm --network "$NET" -v "$WORK:/out" -w /out --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e BASE_URL="http://$APP:8080" -e ADMIN_USERNAME="$ADMIN_USERNAME" -e ADMIN_PASSWORD="$ADMIN_PASSWORD" "$PW_IMAGE" \
  bash -c "npm i -s --no-save playwright@1.49.1 pdf-lib@1.17.1 >/dev/null 2>&1 && \
    OUT_DIR=/out/doc $([ "$WHAT" != guide ] && echo 'node generate-examples.js &&') \
    OUT_DIR=/out/guide $([ "$WHAT" != examples ] && echo 'node generate-guide-screenshots.js &&') true"

if [ "$WHAT" != guide ]; then
  cp "$WORK/doc/clayscorer-example-outputs.pdf" docs/example-outputs.pdf
  echo "Wrote docs/example-outputs.pdf"
fi
if [ "$WHAT" != examples ]; then
  mkdir -p docs/guide
  cp "$WORK"/guide/*.png docs/guide/
  echo "Wrote docs/guide/*.png"
fi
echo "(The Playwright image $PW_IMAGE is left cached; remove it with: docker rmi $PW_IMAGE)"
