---
name: diff-review
description: Review a change from its diff alone, assuming it is wrong. Use for authority, migration, effect and test changes.
---
# Diff review

1. Read only the diff and the contracts it touches. Do not read the implementer's notes first.
2. For each change, name the concrete trigger and its consequence if it is wrong.
3. Check that:
   - authority only narrows;
   - an unknown outcome is never success and is never resent;
   - each effect has an idempotency key;
   - no test was weakened, skipped or deleted without a reviewed reason;
   - the acceptance IDs claimed actually turn green.
4. Report findings ranked by severity, then a verdict: accept, accept with fixes, or reject.
