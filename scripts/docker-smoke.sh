#!/usr/bin/env bash
# Run later, on a machine where Docker is available. Uses only the committed HEAD.
set -Eeuo pipefail
root=$(git rev-parse --show-toplevel)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/backbone-docker-smoke.XXXXXXXX")
id=$(basename "$tmp" | tr '[:upper:]' '[:lower:]')
image="$id:smoke"
volume="$id-home"
container="$id-daemon"
init="$id-init"
cleanup() {
  local status=$?
  trap - EXIT
  for name in "$init" "$container"; do
    if docker container inspect "$name" >/dev/null 2>&1; then
      docker rm -f "$name" >/dev/null || status=1
    fi
  done
  if docker volume inspect "$volume" >/dev/null 2>&1; then docker volume rm "$volume" >/dev/null || status=1; fi
  if docker image inspect "$image" >/dev/null 2>&1; then docker image rm "$image" >/dev/null || status=1; fi
  rm -rf -- "$tmp" || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$tmp/export"
git -C "$root" archive HEAD | tar -xf - -C "$tmp/export"
docker build -f "$tmp/export/deploy/docker/Dockerfile" -t "$image" "$tmp/export"
docker volume create "$volume" >/dev/null
cli=packages/surfaces/cli/src/main.ts
docker run --name "$init" --rm -v "$volume:/data" -e BACKBONE_HARNESS=stub "$image" node "$cli" projects create 'Docker smoke'
docker run -d --name "$container" -v "$volume:/data" -e BACKBONE_HARNESS=stub "$image" >/dev/null
ready=0
for ((i=0; i<120; i++)); do
  if docker logs "$container" 2>&1 | grep -q 'api line up (reads and local project creation)'; then ready=1; break; fi
  if [[ $(docker inspect -f '{{.State.Running}}' "$container") != true ]]; then break; fi
  sleep 1
done
if [[ $ready != 1 ]]; then docker logs "$container"; echo 'Daemon did not become ready' >&2; exit 1; fi
docker logs "$container"
doctor=$(docker exec "$container" node "$cli" doctor --json)
printf '%s\n' "$doctor"
printf '%s\n' "$doctor" | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const d=JSON.parse(s);if(!d.ok || !d.checks.some(x=>x.name==="holder" && x.status==="ok" && x.detail.includes("api line")) || !d.checks.some(x=>x.name==="projects" && Number(x.detail)>=1)) process.exit(1)})'
binding=$(docker exec "$container" node "$cli" channels bind --json)
printf '%s\n' "$binding"
printf '%s\n' "$binding" | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{if(!JSON.parse(s).code) process.exit(1)})'
docker image inspect "$image" --format 'Image size: {{.Size}} bytes'
