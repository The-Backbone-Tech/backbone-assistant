# Surfaces (L3)

Doors a person or another tool uses. Surfaces use the platform `api` (or its Gateway) only: projection in, command out, receipt back. Each has a `backbone.module.json` and a README in the piece shape.

- `app/`: the thread app (Electron and React, or a browser over its HTTP bridge).
- `mcp/`: the MCP door, four tools over stdio for Claude Code, Codex, Hermes and OpenClaw.
- `cli/`: the `backbone` command line over the platform `api`.
- `channels/`: Slack and Telegram conversations over the shared Host, composed by the daemon when configured.
- Planned, with no folder yet: an OpenAPI door over HTTP, and an A2A door (`docs/repo-design.md`, Doors to other tools).
