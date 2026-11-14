# Hermes hosted behind the engine port

This is an internal experimental module. It needs a compatible Hermes process and a platform ToolHost; the app does not select it.

File listings and reads label originals as `original source` and other documents as `recorded version`. The ToolHost does not expose whether a version was restored, so these labels do not identify who authored or saved it; they imply no trust or permission.
Hermes runs the agent loop in its own contained plane. Backbone holds custody, authority and verified completion. This is the decision of 31 October: reach Hermes's breadth by hosting it, not by rebuilding it. It is experimental, opt-in and in no default; no app composition selects it. Pinned to Hermes v0.22.5, commit `bf0203a7`; admission refuses any other version.

## The boundary

Hermes's tools execute inside Hermes, so each call asks Backbone first.

- **Host interface.** The adapter drives Hermes's supported API server: `POST /v1/runs` with an `Idempotency-Key`, the run's event stream, and its stop and steer controls.
- **Hook.** `plugin/host_gate` registers the `pre_tool_call` plugin hook. Hermes fails closed if that callback raises or times out, and the plugin itself blocks on anything but an explicit `allow`, including an unreachable gate. The shell hook is never used: it fails open by default.
- **Gate.** The plugin asks a loopback server in this adapter, per call, against current state, and policy is read again at the crossing. So policy tightened during a run reaches the next call of that run, though Hermes keeps offering the tool until the run ends.
- **Doors.** `door_list_files`, `door_read_file` and `door_write_file` carry a call to the ToolHost. A write crosses only through `writeIfVersion`, as the Codex engine imports: on the version of that file this turn read, or as a new file, citing every version the turn read. A ToolHost without it gets no write: it is refused, never sent through the unconditional `write`. So a write crosses the core's effect gateway, and a person's edit made meanwhile stands. Nothing else can cross.
- **Hermes's own tools.** Its memory, skills and task list (`memory`, `skills`, `todo` in v0.22.5) act only on the plane's data folder, so they stay on, as when a person uses Hermes directly: the gate allows them without a door, `narrow` can still refuse them, and their completion is a `done` event. Memory is the built-in one: an external provider would send it out. Skills load from the data folder only and run no shell.
- **No auxiliary route.** Hermes's auxiliary tasks reach a model route of their own, which this adapter cannot pin to the plane's model or verify. So session search is off and refused at admission if Hermes reports it, and the plane turns off background review, the memory nudge, title generation and context compression. Session search returns when the auxiliary route can be pinned to the primary and verified. Hermes reports no setting for background review, so for that one the plane's config is the only control.
- **Everything else native stays off,** until it has a crossing that requires a host decision: the terminal, files, code execution and subagents, whose effects would sit outside Backbone's receipts, and anything that could act on the person's accounts or the outside world: web and browser tools, messaging gateways and MCP servers. Hermes has no provider-side web search; its web tools run in the plane, so they are off too. These are off at Hermes itself (`platform_toolsets.api_server`, no `mcp_servers`), admission refuses a Hermes with any other toolset on, by name, including a toolset under a familiar name with a tool it should not have, and a call that reaches the gate anyway is refused with a `refused` event. Real source-system writes stay closed.

`narrow` is a trusted composition function, read per call, that can only refuse. The gateway still decides each write.

**The gate's line.** The plane's secret never travels.

- **Keys.** Each turn's key is derived from the secret, the gate's epoch and the turn's Hermes session. The epoch is random at each start of the gate. The plugin asks for it with a fresh nonce and takes it only when the gate signs it over that nonce and a current time, under a key only the secret gives. So the key rotates with every turn and with every gate restart, and an impostor can neither hand out an epoch nor get a request signed.
- **Requests.** Each carries a fresh nonce, the time and a MAC over both and its body. The gate refuses a request that is unsigned, signed for another turn or another epoch, 60 seconds or more from its clock, or a repeat of a nonce it accepted; accepted nonces are kept for twice the window, the whole time a request could still be valid. A request captured before a restart, or held back past its time, fails even on first delivery.
- **Limit.** Loopback HTTP has no confidentiality. An active relay sitting between a live plugin and a live gate can see a request and deliver it first, inside the window. It still cannot change it, sign another, or read the secret.
- **Replies.** Each carries a MAC over the request's nonce and time and its own body. The plugin treats a reply it cannot verify as no reply: the call is blocked and counted. A process that takes the gate's port learns nothing and cannot forge a decision, a delivery or a report.
- **Keys toward the engine.** A text is compared as bytes: its UTF-8, then each stage of percent-decoding it, bytes to bytes, in either case, at most four passes. Each stage is compared with each key's UTF-8, its base64 and base64url with or without padding, and its hex in any case. So a literal key, those encodings, and a key percent-encoded at any mix of depths and case are caught, non-ASCII keys included.
- **Withheld, never rewritten.** A text that matches is withheld whole. A request or a steer that carries a key is refused before it is sent. Any text the gate sends back that carries one becomes the fixed placeholder `[withheld]`, or empty if a key would show in the placeholder itself. Events and outcomes toward Backbone are treated the same way. In the journal only a file name is content and can be withheld; kinds, ids and outcomes are what recovery reads, so they are never rewritten, and an entry whose call or run id carries a key is not recorded: its write is refused before it is proposed, and its run is stopped. A key that is also an ordinary word costs every text that contains it.
- **Limit.** A key split up, embedded in a larger encoded text, or otherwise transformed is not recognised. That is a stated limit, not containment.
- **The API key.** A turn resolves it once, checks its text against it, and drives Hermes with that same key throughout. A steer does the same for itself.

## The hook is not containment

The hook is policy inside the engine's process. Hermes's two dispatch sites swallow an exception raised by the hook machinery itself and go on to run the tool (`_pre_tool_block` in `agent/tool_executor.py`, `_pre_dispatch_guards` in `model_tools.py`). So this side does not trust that the hook ran:

- no native tool a skipped hook could reach acts beyond the plane's data folder;
- a door call needs a random ticket that the gate issues for that call and those arguments, spent once. The hook hands it to the door through Hermes's documented `modify` return. No ticket, nothing crosses, and the turn fails;
- a `tool.completed` for a call the gate never decided lands as unknown outcome, stops the run and fails the turn.

The last check comes after the fact and reads the engine's own events, so it can lower a turn and proves nothing. **Limit, owned by containment:** a call the gate refused that a faulty dispatcher ran anyway, or a tool that left no event, is not detected, and such a turn can still end `done`. `done` means every call the gate saw closed on a receipt. It says nothing of what the engine did without asking. The hook is policy in the engine's process and the toolset list is its configuration: neither contains a compromised engine. The plane's containment does that.

## The ledger

The gate holds one record per call. `decided`: a ticket exists. `dispatched`: the door received it. `answered`: it has a receipt, which comes only from the ToolHost and never from Hermes. `closed`: the plugin acknowledged the answer before returning it to Hermes, or the hook refused the call and there is no door to answer.

A turn is `done` only if all of these hold: Hermes reports the run completed, the event stream itself was followed to that end with no gap or truncation, nothing lowered the turn, every record is closed on a known receipt, and the plugin's turn report arrived at zero. The report is sent from `post_llm_call`, once per turn, and counts the decisions the hook could not get from the gate. Hermes emits no event for a blocked call, so without it a call blocked by an unreachable gate would leave no trace. A missing or malformed report lowers the turn. A report can never raise it. The rest follows without a further rule:

- a call with no receipt when the run ends is unknown outcome by construction, including one approved at the hook that never reached the door;
- a receipt of DONE whose answer never reached the plugin stays DONE, and the turn is `interrupted`, because the model was told something else;
- a write dispatched at Stop is unknown outcome, as the port says, whatever the host then answers. A late DONE or REFUSED is kept beside it as evidence, in the event's label and the journal, and recovery names it.

The acknowledgement comes from the engine's side. It is evidence of delivery only and cannot change an outcome; a faulty one could at worst claim an answer arrived.

Engine events can only lower a turn. These do: an approval request, a subagent start, a `tool.started` or `tool.completed` that does not name a call the gate allowed for that same tool (Hermes emits neither for a blocked call), a frame without a sequence number, an unreadable frame, a gap, a truncated record, and any frame after the run's end. The stream must then close by itself. The plugin's count is cumulative and never cleared, so a lost report cannot take it along, and any decision after a clean report needs a new one.

## One claim, one exit

A turn's journal file is its claim. It is created exclusively and flushed before `POST /v1/runs`, and never taken twice. Any later start of a claimed turn, whatever `resumed` says and in any process, can only recover: it reports the record, names the writes that finished, stops a run still moving, opens no turn on the gate and submits nothing. If another process holds the gate's port, the run has a live owner and is left alone. A turn refused at admission was never submitted, so it holds no claim.

Each turn moves forward through `admitting`, `running`, `stopping` and `ended`, and everything that can go wrong sets its standing, which only gets worse. `exit` is the one way out: it shuts the gate, settles the ledger and writes the outcome.

## Unknown outcomes

- **A kill during a tool.** Hermes keeps only a turn-level warning and drops the call from the model's view. Here, a write in flight is aborted and reports unknown outcome through the gateway, and one that never answers is reported unknown outcome after `settleMs`.
- **Any action with an unknown outcome.** It stops the run, shuts the gate for the turn, and the turn can no longer end `done`. Any write refused, whether by the gateway, by `narrow` at the hook or in the queue, or for its shape, closes further writes in the turn, and the model is told.
- **A restart.** Recovery never creates a run or calls the model. It reads the journal, reports each unsettled write as unknown outcome, stops a run Hermes is still executing, and returns `interrupted`. With no journal it starts nothing.
- **A lost create.** A `POST /v1/runs` whose answer is lost is not resent, and the claim stays. If the run did start, its tools find no open turn, then or on any retry. It cannot be stopped, since its id was never learned; it can reach the model but no door.
- **Hermes's `resolve-unknown`.** The adapter never calls it. It would acknowledge that the lost execution will not finish, and a child process can outlive its engine. Each turn has its own Hermes session, so a fenced session does not block the next turn. Backbone's history is sent on every run.

- **Deadlines.** A write has its own (`writeTimeoutMs`), a dropped door connection counts as lost at once, and a turn has one overall (`turnTimeoutMs`), since status can say `running` forever. A late DONE reopens nothing.
- **Read-only turns.** They are refused before any run. The port says such a turn is offered only tools that read, and Hermes fixes its tools per plane, with no per-run limit.
- **Reads.** A read still with the host at Stop or withdrawal returns no material: the gate looks again when the host answers.

An approval request or a subagent start stops the run. The adapter never answers an approval.

## Use

```ts
import { createHermesHarness, writePlane } from '@backbone-next/harness-hermes';

await writePlane(homeInsideThePlane, { gateUrl, gateToken, modelBaseUrl, model });
const harness = createHermesHarness({ baseUrl, apiKey, gate: { host: '127.0.0.1', port, token: gateToken }, journalDir, planeModel: { baseUrl: modelBaseUrl, model } });
```

`writePlane` lays out the plugin, its private settings and a config that enables it, turns on Hermes's own toolsets with built-in memory and no skill shell, sets no MCP server, and turns off `tools.tool_search`, which otherwise defers plugin tools behind a bridge. It installs nothing. Provisioning the plane and starting Hermes belong to the owning composition.

Admission checks the version, the required API features, that the door toolset is active and that no toolset but Hermes's own is on, before any run. Only a keyless loopback `endpoint` route equal to `planeModel` is accepted, so no credential crosses into the engine. `planeModel` is declared by the composition that wrote the plane: Hermes reports no effective endpoint, so the match is against that declaration, not an observation.

## Verification and limits

`pnpm --dir packages/modules/harness-hermes test` needs `python3`, not Hermes: a fake host speaks the API server's wire format, and the plugin's failure paths run in a plain Python. `pnpm check` runs it.

`journey/drive.ts` runs this adapter against real Hermes in a disposable VM with no mounts, egress dropped, synthetic data and `journey/scripted_model.py`. Run it by hand. Node stays out of the VM: one SSH channel carries the API server out and the gate in, both on loopback. A scripted model tests the engine only and says nothing of real model behaviour.

Not established or not built:

- A person's edit to a file during a run. Writes go through `writeIfVersion`, but this has no journey here.
- Hermes's private memory, skills and sessions sit outside Backbone's custody until exported through a crossing. The plane data folder holds them; none is exported, and the person's memory from Backbone arrives only through `recall`.
- The person's memory and the earlier conversation reach the run through `request.recall()`, read once as the run is built: their instructions beside the engine's, memory and enabled skills in the input as reference data that cannot change what the agent may do, and the history as it may be sent at that moment (less any answer withdrawn while the run started). A recall that carries a known key is not sent.
- Hermes's own toolsets and the auxiliary settings were checked against v0.22.5's `toolsets.py` and config defaults, not on a real run: the journey predates them. Whether every other auxiliary task (such as memory query rewriting) stays idle with these settings is not established; the plane's dropped egress remains the backstop.
- Hermes tries to fetch a model catalog from the internet on its own. Dropped egress stopped it in the journey; the plane must keep doing so.
- Background work Hermes starts on its own, such as memory or skill review, was not exercised.
- A known key in a door call's name or body is refused before the ToolHost. Text is scrubbed of the two keys this adapter holds, including across frames; encoded forms are not caught. `outcome.answer` is authoritative over streamed text. A steer is offered through `deliver`. Hermes queues it and never confirms that the run took it, so one it accepts is unknown outcome, never DELIVERED; one it refuses, one that carries a key, and every steer whose request has not left when Stop comes or the turn ends settle NOT_DELIVERED and are never sent. The same holds for a run: Stop is checked after the client's last await before the request leaves, so a run Stop overtook is never submitted. A request already sent cannot be recalled.
- The gate serves one plane on loopback. A remote plane needs its own authenticated transport.

## Swap and removal

Select a different Engine module through composition after pending effects are reconciled. Hermes's fenced sessions and its data folder go with the plane. Held unknown outcome stay with the core.

## Closed after park

The integrator's final cold review of `123120e...8d15b6e` found three defects; each is fixed on `claude/hermes-finish` with a test that fails without its fix.

1. Withholding rewrote structural journal fields, so recovery could drop an unsettled write. Now only names are withheld (`a key equal to a journal kind cannot erase an unsettled write`).
2. A steer waiting on the API key could be sent after Stop (`a steer waiting on its key when Stop comes settles NOT_DELIVERED`). The cold review of round 1 found the same gap later, between the last state check and the request leaving, for a steer and for a run; both are closed (`test/crossing.test.ts`).
3. A write refused by `narrow` or in the queue left later writes open (`a write refused by policy, at the hook or in the queue, closes further writes`).

## Manifest

<!-- generated from backbone.module.json by scripts/module-readme.mjs; do not edit -->
| Field | Value |
| --- | --- |
| id | `io.github.albertoangulo/harness-hermes` (module) |
| version, licence | 0.0.0, Apache-2.0 |
| publisher | Backbone maintainers, namespace `io.github.albertoangulo` (github, pending) |
| stability | experimental |
| provides | Harness 0.x |
| consumes | ToolHost 0.x, ModelRoute 0.x |
| capabilities | planes: personal; effect classes: 2; operations: workspace.write_document; network: hermes-contained-plane; secrets: none |
| data | owns: none; migrations: 0; export: nothing durable but per-attempt journals, which are evidence: file names and outcomes, no bodies; threads, effects and documents belong to the core, and Hermes's own state stays in its contained plane outside custody |
| depends on | none |
| conformance | bronze: `packages/modules/harness-hermes/test/harness.test.ts`, `packages/modules/harness-hermes/test/recovery.test.ts`, `packages/modules/harness-hermes/test/crossing.test.ts`, `packages/modules/harness-hermes/test/gate.test.ts`, `packages/modules/harness-hermes/test/keys.test.ts`, `packages/modules/harness-hermes/test/plugin.test.ts`, `packages/modules/harness-hermes/test/vm.test.ts` |
| exemption | shared harness port conformance suite: the Harness port has no shared suite yet; these tests use a fake Hermes host, and the real journey runs by hand in a disposable VM (journey/drive.ts); no app composition selects this module |
| removal | stop active turns first; held UNKNOWNs stay with the core's gateway; Hermes's fenced sessions and its home are removed with the plane; refused while one of its effects is UNKNOWN |
<!-- end of generated block -->
