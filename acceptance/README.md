# Product acceptance jobs

These jobs define useful work and its completion bar for the Backbone distribution. A copied contract or a passing shape check is not a passing job. Neutral mechanisms are judged separately by [conformance](../conformance/README.md) and the [oracle](../oracle/README.md).

| Job | Outcome |
| --- | --- |
| [J-01](J-01/job.md) | Attach a file, edit, save, restart and continue without losing a person's work |
| [J-triage](J-triage/job.md) | Triage incoming requests and compare drafts blind against a baseline |
| [J-solution](J-solution/job.md) | Choose an eligible route, execute and verify a whole task |
| [J-co](J-co/job.md) | Continue a company function across people, tools and recovery |
| [J-ma](J-ma/job.md) | Coordinate parallel work and preserve steering and merged results |

The [J-solution method](J-solution/method-v1/method.md) includes frozen synthetic inputs, a [T3 scoring checker](J-solution/method-v1/scoring/verify-t3.mjs) and an [isolation probe](J-solution/method-v1/arrangement/boundary-probe.mjs). Keep scoring and other arms' outputs unreadable to the executor; co-location in one repository does not provide isolation. The method remains a draft pending its existing review and freeze.

The local acceptance grader checks job titles, local conformance references and owned paths. It runs in the static rules; its tests run with `node --test scripts/acceptance.test.mjs`. This move does not introduce a result, change a pass threshold or qualify a live provider. The legacy requirement-coverage and generated status tools still belong to `backbone-way:scripts/req-coverage.mjs` and `backbone-way:scripts/status.mjs` with their unmoved requirement owners; their linked-repository status is not a product gate here.
