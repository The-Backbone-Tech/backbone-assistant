---
name: task-brief
description: Write or follow a one-task brief for an agent. Use before starting any change.
---
# Task brief

A task is a useful result with enough scope for its actual consumer to work. Keep the change reviewable and name the files and checks it needs across layers. Split independent work where that improves delivery; an arbitrary file or suite count does not define a task.

Use the task authority and [contribution guidance](../../../CONTRIBUTING.md). A changed contract, a failing baseline or ambiguity calls for diagnosis and a supported decision within that authority. Coordinate another author's files and revise the owning contract where justified. Preserve the failure and explain the change; do not silently weaken acceptance or stop for a permission already given. Report an unavailable dependency precisely and continue independent work.

```markdown
# Task <id>: <one-sentence outcome in user terms>
Agent/model:            Effort:            Branch/worktree:            Base commit:
## Ground truth    current behaviour -> desired behaviour; start at <file/test/error>
## Context         docs/architecture.md#..., docs/contracts/<piece>.md, a distribution's requirement IDs if it serves one (paths only)
## Owns            files/dirs this task may edit
## Do not touch    shared schema, other pieces, conformance/, oracle/
## Interfaces      current contracts and consumers; any justified change and affected checks
## Non-goals       adjacent work out of scope
## Done when       observable result, proving checks and evidence level; exact candidate and unresolved limits
## Dependencies    what this work actually needs; who owns it; resolution and independent work continuing
## Report          changed files; raw command output; deviations; open questions; model/effort used
```
