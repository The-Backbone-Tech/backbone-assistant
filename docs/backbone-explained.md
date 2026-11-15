# Backbone explained

Backbone's goal is a complete, open-source and composable working environment for people and capable AI: use one useful part, combine selected parts with existing tools, or run the whole product. The [goal](../GOAL.md) sets the outcome; this page explains the idea. The [roadmap](execution.md) separates current implementation from work still open.

## The idea

Give the assistant a job, relevant sources and permission. It chooses a feasible route through existing tools, subscriptions and models, does and verifies the work, preserves corrections and shows its result. The conversation, files, document versions and record of outside actions remain inspectable.

The intended value combines strong current capabilities, coherent working surfaces, useful freedom for AI and an environment that gets clearer with use. People and agents can work on the same documents, tables, data and tasks, understand decisions, correct knowledge and reuse effective methods. Continuity, source authority, visible uncertainty, recovery and export support that outcome. PostgreSQL is the current relational and durable operating substrate. Earlier repositories supply vision and lessons rather than an implementation to reconstruct.

## The design

[Shape](shape.md) describes the responsibilities and 21 required properties. Core preserves stable guarantees. Platform exposes ports and composes services. Modules implement integrations; surfaces expose the app, CLI, MCP and channels. A distribution supplies brand and defaults. Nothing depends on a distribution.

Authority only narrows. A permitted tool proceeds inside the permission signed once. An unsigned operation is held for the person. An unknown outside outcome remains unresolved until reconciled; changing engines does not authorize a blind resend. Human edits, source identity and work must survive those changes.

## Choose what serves the work

Use [the method](method.md): understand the outcome and actual operating constraints, compare keeping existing tools with configuring, integrating or building, investigate the uncertainty that could change the choice, and retain reasons and limits. A maintained tool can be the best route. Commercial incentives must not bias the recommendation.

Arena can supply dated comparison evidence but is optional. A separate simulation service is not a product dependency. A complete company arrangement must account for identity, source access, policy, cost, recovery and exit as well as model quality.

## Evidence and next steps

The [source map](map.md), [scorecard](scorecard.md), [contracts](contracts/) and [guides](how-to/) locate implemented capabilities and their qualification limits. A scripted test establishes its bounded behaviour; an installed check establishes that consumer; human use and complete-job comparisons establish different claims.

Start with personal conversation, files, mail, calendar, memory and background work. Team and company configurations need their own identity, collaboration and fleet qualification. [Acceptance jobs](../acceptance/README.md) define complete results. Contribute through the [development guide](development-map.md).
