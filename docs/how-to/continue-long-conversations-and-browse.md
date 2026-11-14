# Continue a long conversation and use web pages

Keep sending messages in the same chat. Pi uses its maintained compaction
library when context approaches its configured window. Codex and ACP agents that
support compaction use their own mechanism. A compaction appears in the thread:
expand it to read the summary, inspect reported usage and follow an Earlier turn
link to the original conversation. Some engines expose only a compaction marker;
the app says when there is no readable summary. Original turns remain available.

Context estimates are not billing counts. Pi's summarization usage is included in
the turn total. Codex and ACP do not report a separate compaction bill through
their compaction events. A summary failure or Stop leaves an explicit incomplete
outcome instead of claiming that the job continued.

Pi inherits a 200,000-token window when none is supplied. For a route with another
known window, set BACKBONE_PI_CONTEXT_WINDOW to that positive token count before
starting the app or CLI. For example, a local model configured for 32,768 tokens
can launch the source app with:

```bash
BACKBONE_PI_CONTEXT_WINDOW=32768 pnpm --dir packages/surfaces/app start
```

This sets both the compaction threshold and an output allowance that fits its
reserve. It does not query or change the provider's own limits. Standalone
harness callers can pass contextWindow explicitly instead of the launch setting.

For native web lookup, select Codex in Full mode as described in
[the native guide](use-native-codex.md). Web pages that need interaction use a
maintained browser connected through Settings, Connected tools. For example,
install the [Playwright MCP server](https://github.com/microsoft/playwright-mcp)
in your own client's MCP configuration, pinning the tested version:

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@0.0.85", "--isolated", "--no-webmcp"]
    }
  }
}
```

Use Pi or Codex for this browser route. The experimental ACP route does not yet
support these connected browser reads.

The no-webmcp option disables page-registered tools. A page tool and its read-only annotation are the page's claims; they do not grant authority. If another configuration exposes webmcp_ tools, the Host treats them as effects regardless of annotations or read overrides.

The server needs a supported browser installation. Refresh Connected tools and
enable the connection and the tools you need. A useful small set is
browser_navigate, browser_snapshot, browser_fill_form and browser_click. Use the
existing Signed tools controls for the scope you intend to delegate. Once those
tools are signed, looking up a page, filling it and submitting under that grant
adds no per-site signing. Unsigned effect calls wait for the person and do not go
out. Signing browser_click covers clicking controls, including submission; read
its scope before signing it. The browser's own login/profile remains its own.

An action can reach the site before the browser times out. That timeout is
UNKNOWN even when the browser returns an error reply, and the engine stops
dependent work. Automatic release pauses for that tool on that connection until
resolution. Independent work in another turn can still use other enabled tools
or connections. An error after invocation, including a closed page or lost connection, also stays UNKNOWN. A disabled-button timeout pauses the same tool even when nothing was submitted: the connector cannot prove non-delivery from the error alone. The local regression covers both browser and transport deadlines and a connection lost after delivery; it does not qualify arbitrary sites or purchases.

Inspect the signed submission receipt in the connector history. UNKNOWN means
the outcome is uncertain and is never resent automatically. Check the site and
use the existing resolution controls before another submission. A browser error
alone does not prove the site did nothing. Avoid auto-submit controls until their
outside effects are included in the grant for the tool that triggers them.

Company configuration may narrow sites through the browser service or a network
proxy. Playwright's origin filters are convenience rules, not redirect-proof
network isolation. There is no new personal per-site dialog.

## Account-free checks

These focused tests use a scripted local model and a fake ACP process. They
exercise engine compaction and event projection, not a real provider:

```bash test
node --test packages/modules/harness-pi/test/compaction.test.ts
node --test packages/modules/harness-codex/test/compaction.test.ts
node --test packages/modules/harness-acp/test/compaction.test.ts
```

The implementation
separates engine features, costs and the limits of the local browser proof.

The whole platform suite also exercises the actual maintained browser against a
local fixture. Install the pinned test browser before running that suite:

```bash
pnpm --dir packages/platform exec playwright install chromium
pnpm --dir packages/platform test
```

CI performs the existing Chromium installation before the platform suite as
well as the app journeys. The browser test contacts only its owned loopback
page, runs an isolated browser profile, and uses no real account.
