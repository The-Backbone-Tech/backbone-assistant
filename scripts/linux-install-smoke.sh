#!/usr/bin/env bash
# Exercise the committed package in a clean container. Requires Docker and npm network access.
set -Eeuo pipefail
if (($#)); then echo 'usage: scripts/linux-install-smoke.sh' >&2; exit 2; fi
root=$(git rev-parse --show-toplevel)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/backbone-linux-install.XXXXXXXX")
volume=$(basename "$tmp" | tr '[:upper:]' '[:lower:]')-home
cleanup() {
  local status=$?
  trap - EXIT
  if docker volume inspect "$volume" >/dev/null 2>&1; then docker volume rm "$volume" >/dev/null || status=1; fi
  rm -rf -- "$tmp" || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$tmp/export" "$tmp/pack"
git -C "$root" archive HEAD | tar -xf - -C "$tmp/export"
# The packer uses git ls-files and imports the installed development dependencies.
git -C "$tmp/export" init -q
git -C "$tmp/export" add -A
ln -s "$root/node_modules" "$tmp/export/node_modules"
while IFS= read -r -d '' dir; do
  rel=${dir#"$root"/}
  if [[ -d "$tmp/export/${rel%/node_modules}" ]]; then ln -s "$dir" "$tmp/export/$rel"; fi
done < <(find "$root/packages" -name node_modules -type d -prune -print0)
tarball=$(cd "$tmp/export" && node scripts/pack-cli.mjs "$tmp/pack")
docker volume create "$volume" >/dev/null
docker run --rm -v "$volume:/data" node:22-bookworm-slim chown node:node /data
# The package goes in on standard input, not as a bind mount: a Docker daemon in a VM or on another
# host (Colima, a remote context) cannot see this computer's temporary folder and mounts an empty
# directory in its place.
docker run --rm -i --user node -v "$volume:/data" \
  -e BACKBONE_HOME=/data/home -e BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK=1 \
  node:22-bookworm-slim sh -eu -c '
    cat > /tmp/package.tgz
    npm install -g --prefix /tmp/prefix --no-audit --no-fund /tmp/package.tgz
    export PATH=/tmp/prefix/bin:$PATH
    backbone --version
    set +e
    backbone doctor > /tmp/first-doctor 2>&1
    status=$?
    set -e
    cat /tmp/first-doctor
    test "$status" -eq 1
    grep -F "BACKBONE_KEYS=plaintext backbone projects create" /tmp/first-doctor
    BACKBONE_KEYS=plaintext backbone projects create "Linux install test"
    BACKBONE_KEYS=plaintext backbone projects list | grep -F "Linux install test"
    BACKBONE_KEYS=plaintext backbone doctor --json > /tmp/doctor.json
    cat /tmp/doctor.json
    node -e '\''const d=require("/tmp/doctor.json"); if (!d.ok) process.exit(1)'\''
    du -sk /tmp/prefix | awk '\''{print "Installed size: " $1 " KiB"}'\''
  ' < "$tarball"
