# Backbone explained

Backbone is an open-source AI assistant for people, teams and companies. The [goal](../GOAL.md) sets the outcome; this page explains the idea. The [roadmap](execution.md) separates current implementation from work still open.

## The idea

Give the assistant a job, relevant sources and permission. It chooses a feasible route through existing tools, subscriptions and models, does and verifies the work, preserves corrections and shows its result. The conversation, files, document versions and record of outside actions remain inspectable.

The intended value is continuity across engines and tools: one record of work and permission, data authoritative where it lives, visible uncertainty, recovery after interruption and export without dependence on a proprietary Backbone service.

## The design

[Shape](shape.md) describes the responsibilities and 21 required properties. Core preserves stable guarantees. Platform exposes ports and composes services. Modules implement integrations; surfaces expose the app, CLI, MCP and channels. A distribution supplies brand and defaults. Nothing depends on a distribution.

Authority only narrows. A permitted tool proceeds inside the permission signed once. An unsigned operation is held for the person. An unknown outside outcome remains unresolved until reconciled; changing engines does not authorize a blind resend. Human edits, source identity and work must survive those changes.

## Choose what serves the work

Use [the method](method.md): understand the outcome and actual operating constraints, compare keeping existing tools with configuring, integrating or building, investigate the uncertainty that could change the choice, and retain reasons and limits. A maintained tool can be the best route. Commercial incentives must not bias the recommendation.

Arena can supply dated comparison evidence but is optional. A separate simulation service is not a product dependency. A complete company arrangement must account for identity, source access, policy, cost, recovery and exit as well as model quality.

## Evidence and next steps

The [source map](map.md), [scorecard](scorecard.md), [contracts](contracts/) and [guides](how-to/) locate implemented capabilities and their qualification limits. A scripted test establishes its bounded behaviour; an installed check establishes that consumer; human use and complete-job comparisons establish different claims.

Start with personal conversation, files, mail, calendar, memory and background work. Team and company configurations need their own identity, collaboration and fleet qualification. [Acceptance jobs](../acceptance/README.md) define complete results. Contribute through the [development guide](development-map.md).
