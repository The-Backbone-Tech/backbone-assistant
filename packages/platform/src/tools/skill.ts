// The usage skill installed beside a connected tool (SKILL.md, plain text). Short on purpose: its
// description is loaded into every session of the tool, so every word costs context.
export const SKILL = `---
name: backbone
description: Use when the backbone-door MCP tools are available. How to act through them safely.
---

# Acting through the backbone door

The person allowed these actions in their app; each one is checked and gets a receipt.

- Give every \`propose_effect\` a new, unique \`idempotencyKey\`. Reuse a key only to ask about that same action.
- Show the person the receipt: what was done, its outcome and its id.
- Only \`DONE\` is success. \`UNKNOWN\` means nobody can tell whether it happened: never retry it, under any key. Tell the person.
- \`AWAITING_DECISION\`: the person decides in their app. Check later with \`effect_status\` and the same key.
- A refusal is final. Never work around it with another tool, key or wording. Ask the person to widen the permission in their app.
`;
