# Decisions and references

This page records product choices and evidence limits. [GOAL](../GOAL.md) owns the outcome; [method](method.md) explains how to choose; the [roadmap](execution.md) records open work.

## The actual choices

- Keep app, runtime, configuration, contracts and acceptance jobs in one product repository. Kernel and Engine are package responsibilities with checked dependency direction.
- Keep Arena optional and separate. Backbone works without an external evidence service.
- Adopt maintained tools where they solve the job: connector tool discovery, engine conversation handling and interactive browsing are integration paths, not claims of universal provider qualification.
- Preserve authority, human edits, source identity and unresolved outcomes across engine changes and recovery.
- Use the existing gate and focused tests at their affected consumers. Faster checking is useful only with equivalent defect detection.

## Research dispositions, reviewed 13 November 2026

The source includes mechanisms for route choice, compaction, memory, connector permissions, export and managed policy. Their contracts and named tests show implementation coverage. Controlled benefit comparisons, complete-job acceptance and every real-provider combination remain separate claims.

Do not treat a passing component test, a vendor benchmark or a historical observation as acceptance of a composed release. Compare complete jobs when a build-or-adopt decision or a claim of improvement depends on it, including correction, interruption, recovery and operating effort.

## References

The [reference library](references-2026-11.md) and [source comparisons](references/) record dated external research. Read their dates and scopes before using them for a current choice. The [architecture](architecture.md), [source map](map.md), [specifications](specs/README.md) and [ADRs](adr/) own the corresponding implementation and design claims.
