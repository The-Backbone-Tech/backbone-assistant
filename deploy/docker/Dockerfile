# The headless daemon on Linux: the host without the app, for one data home in a volume, so
# schedules, the heartbeat and goal runs go on with no desktop. It runs the Pi engine (a model route
# you set up: your own key, a gateway, or a local endpoint) and the stand-ins; Codex and Claude sign
# in through their own apps, which this image does not carry.
#
# The image is deliberately minimal (decided 10 November 2026): the command line's workspace
# dependency closure, which reaches the Pi engine, mail connector and optional telemetry module.
# The Codex and ACP engines and the MCP door are loaded by folder, are not in that closure, and are not
# copied, so a daemon in this image cannot choose them. An image that carries one of them also has
# to carry that engine's own program and sign-in; that is a separate variant, not this file.
# The image carries the telemetry module, loaded only when the home names an endpoint.
#
# Build from the repository root (nothing is published):
#   docker build -f deploy/docker/Dockerfile -t backbone-daemon .
# The build reaches the network for the base image, Corepack's pnpm and the package install only.
FROM node:22.23.3-bookworm-slim

# The package manager the repository pins, through Node's own corepack.
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate

WORKDIR /opt/backbone
# Only what the daemon runs: the workspace manifests, then the command line and the packages it
# depends on. Each COPY below takes a package folder, but the build context holds only allowlisted
# files of it (.dockerignore, from `node scripts/lib/docker-context.mjs --write`): manifests and
# source files by type, and each tracked file of a module. A credentials file, a data home or
# evidence/ beside them is never sent, so it cannot reach a layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# Package folders contain only files allowed by the generated context.
COPY packages/core packages/core
COPY packages/kernel packages/kernel
COPY packages/modules/connector-mail packages/modules/connector-mail
COPY packages/modules/harness-pi packages/modules/harness-pi
COPY packages/modules/telemetry-otel packages/modules/telemetry-otel
COPY packages/platform packages/platform
COPY packages/surfaces/channels packages/surfaces/channels
COPY packages/surfaces/cli packages/surfaces/cli
RUN pnpm install --frozen-lockfile --filter "@backbone-next/cli..." \
 && chown -R node:node node_modules/.pnpm/@embedded-postgres+* \
 && mkdir -p /data && chown node:node /data
# The bundled PostgreSQL links its own libraries on first start, so its package folder belongs to the
# user that runs it; the rest of the install stays root's and read-only.

# PostgreSQL refuses to run as root, and the home is the person's alone.
USER node
# A headless home keeps its keys in plain files inside the volume (BACKBONE_KEYS=plaintext): protect
# the volume as you would the keys themselves.
# The data home lock on Linux is an experimental opt-in (an OFD lock, not yet qualified on Linux):
# the image sets it so the daemon can write /data. Keep /data on a local named volume; the lock
# refuses network, overlay and unknown filesystems, so a home in the container's own layer is refused.
ENV BACKBONE_HOME=/data BACKBONE_KEYS=plaintext BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK=1
VOLUME ["/data"]
CMD ["node", "packages/surfaces/cli/src/main.ts", "daemon", "run"]
