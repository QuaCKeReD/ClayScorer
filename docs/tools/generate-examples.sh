#!/usr/bin/env bash
# Regenerates docs/example-outputs.pdf from the current working tree.
# Needs Docker only: builds a throwaway image of this checkout, runs it on a private network
# with an in-memory database, drives it with the official Playwright image, then cleans up.
set -euo pipefail
cd "$(dirname "$0")/../.."
PW_IMAGE=mcr.microsoft.com/playwright:v1.49.1-noble
NET=cs-examples-$$
APP=cs-examples-app-$$
WORK=$(mktemp -d)
cleanup() {
  docker rm -f "$APP" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker rmi -f clayscorer:examples >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

docker build -q -t clayscorer:examples . >/dev/null
docker network create "$NET" >/dev/null
docker run -d --name "$APP" --network "$NET" --user 1000:1000 --tmpfs /data:uid=1000,gid=1000 \
  -e ADMIN_USERNAME=examples -e ADMIN_PASSWORD=examples-not-used clayscorer:examples >/dev/null
sleep 3

mkdir -p "$WORK/doc"
cp docs/tools/generate-examples.js "$WORK/"
# Run as the calling user so the work folder (node_modules etc.) can be cleaned up afterwards.
docker run --rm --network "$NET" -v "$WORK:/out" -w /out --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e BASE_URL="http://$APP:8080" -e OUT_DIR=/out/doc "$PW_IMAGE" \
  bash -c "npm i -s --no-save playwright@1.49.1 pdf-lib@1.17.1 >/dev/null 2>&1 && node generate-examples.js"

cp "$WORK/doc/clayscorer-example-outputs.pdf" docs/example-outputs.pdf
echo "Wrote docs/example-outputs.pdf"
echo "(The Playwright image $PW_IMAGE is left cached; remove it with: docker rmi $PW_IMAGE)"
