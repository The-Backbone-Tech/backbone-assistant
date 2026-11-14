# Use the experimental ACP engine alone

An ACP agent runs as you. With restricted-writes, it can read whatever you can read except the listed credential places, this Host's data folder, denied folders and ACP storage outside its own folders. It can read environment variables and command lines of your other running programs, which often hold API keys. It has unrestricted outbound IP network, including loopback. The restricted-writes setting only stops it writing outside its own folders, signalling other processes and starting system background services. With person-rights, a custom agent can read and write this app's data folder, including settings.json, and reach machine credentials; OS restrictions are off. The credential places are listed in `CREDENTIAL_PATHS` in `packages/platform/src/ports/harness.ts`. The route stays off until `harnesses.harness-acp.acceptsProcessVisibility` is explicitly true in this data folder's settings; selecting the engine is insufficient. A standalone caller must pass acceptsProcessVisibility: true as well.

The [ACP module](../../packages/modules/harness-acp/README.md) implements the platform engine port for a configured ACP executable. It is experimental; restricted-writes execution uses the macOS deny-default profile and refuses unsupported hosts. Use its observed capability table before selecting an environment or relying on native session continuity.

From the repository root, after the workspace install, run the local fake-agent example and its boundary tests. No provider, account, real data folder or sign-in is used:

```bash test
pnpm --dir packages/modules/harness-acp test
```

The suite includes real macOS canaries for write and service rules and records the process visibility risk that requires explicit acceptance: a restricted-writes agent can read other same-user programs' environment variables, including their tokens. Backbone's bridge capabilities stay in session-private files. Protocol-only person-rights controls do not replace the OS canaries.

The [first test](../../packages/modules/harness-acp/test/harness.test.ts) is a runnable standalone example: it creates the engine with a command and arguments, starts a turn with a ToolHost, consumes streamed events and the outcome, then closes the engine. Its fake writes “ready”; subsequent cases exercise cancellation, refusal, macOS write and service limits, canonical tool crossings and continuity. Protocol tests can use an explicit person-rights local fake on other systems; restricted-writes execution there is refused.

For a data folder, use Settings → AI and models to resolve an already installed ACP executable and review its real path, hash and rights before accepting and saving it. The module README describes the corresponding two-step API. Old settings without bound acceptance stay disabled. The agent owns its model and authentication; the platform neither signs in nor pretends to select a vendor model. Keep environment values out of settings and name only the variables the agent needs. Start with a disposable data folder and a read-only task when qualifying an actual agent. A real provider can incur its own charges even though the module stores no platform model credential.

To remove or swap the route, close the engine and select another module through the existing composition. Canonical history, documents and effect receipts stay with their existing owners. Native sessions and agent state are not a portable backup.
