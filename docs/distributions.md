# Distribution settings

A distribution is data: a module list, defaults and a brand profile. It does not patch package code. Start with [README.md](../README.md) for setup and the first job. This page owns the configuration rules.

## Build your own distribution

Backbone's configuration is [here](../distributions/backbone/distribution.json). Other brands can use the [neutral example](../examples/distribution/distribution.json). Set BACKBONE_DISTRIBUTION to the JSON file when building. Relative paths resolve from the shell's working folder (pnpm's INIT_CWD), not the app package.

```bash test
BACKBONE_DISTRIBUTION=examples/distribution/distribution.json pnpm --dir packages/surfaces/app build
grep -q '<title>Example Assistant</title>' packages/surfaces/app/dist/renderer/index.html
```

The [loader](../scripts/lib/brand.mjs) validates against the [schema](../schemas/distribution.schema.json). An invalid profile or missing icon stops the build. The [distribution check](../scripts/distributions.mjs) also verifies module names and the selected default engine. Without this input, a build uses Assistant. A runtime guard checks the selected file, so a default build refuses a distribution fallback even if it uses the Assistant name. Packages never select Backbone's folder themselves, so another brand can use the same platform.

**Current limit (source read, 10 November 2026):** the app build consumes the brand profile. The module list and defaults are validated configuration; the host chooses its actual engine from its own settings and route. This file does not implement personal, team or company deployment presets, a policy resolver or a plugin installer.

## White-label rules

| Brand field | Current consumer |
| --- | --- |
| `name` | Window and renderer text; packaging name |
| `appId` | Bundle identifier; if absent the loader derives one from the name |
| `icon` | Optional PNG beside the JSON; packaging consumes it |
| `light`, `dark` | Validated values, reserved; the app does not read them yet |

For an icon and an unsigned package, use [build a white-label app](how-to/build-a-white-label-app.md). Keep your configuration under version control. No sibling repository is required. Package names, scopes and code identifiers remain unchanged when the visible name changes.

Rebranding does not change the [guarantees and limits](architecture.md), tests or licence. Keep LICENSE and NOTICE. See [TRADEMARKS.md](../TRADEMARKS.md) for the proposed name policy.
