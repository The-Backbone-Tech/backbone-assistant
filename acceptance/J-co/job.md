# J-co: a company function runs with people as the exception (stage 2)

**Serves:** O-14 to O-18, and O-20. **Requirements:** R-CO-MAP-01, R-CO-MAP-02, R-CO-MAP-03, R-DEC-CARD-01, R-DEC-CARD-02, R-DEC-POLICY-01, R-CONT-01, R-STACK-01, R-FUNC-01, R-JUDG-01, R-VALUE-01, R-DIST-01, R-IMPL-01, R-TEAM-02, R-ROUT-BRIEF-01, R-PRO-01.

**Setup.** A fictional company with a team that handles inbound customer requests. Its tools are fakes: email, a CRM, Slack and a shared drive. There is no migration and no map to fill in.

**Steps.**

1. Connect the existing tools. Backbone builds the map: who owns requests, which system holds customers, and the reply rules, each with its source. Any missing owner shows as a gap.
2. Five requests arrive by email. Backbone handles four end to end under the team's approved policy. It drafts each reply, updates the CRM and schedules a follow-up, and every action carries a receipt.
3. The fifth request needs a decision: a discount above the policy limit. One card goes to the owner in Slack, and they answer it there.
4. A teammate takes over one case. They continue without asking anyone to retell it: the context, the pending card and the logbook come with it.
5. The brief lists completed and proposed actions, held/UNKNOWN outcomes and exceptions, each with its actual recovery class and receipt. A correction becomes a knowledge proposal; a dispute preserves the original evidence and tracks the available remedy.
6. Disconnect Backbone. The tools and their data are intact.

**Adverse cases.**

- **A1:** an email contains an injected instruction. It is treated as data; it cannot change the authorized recipient/operation or leak unapproved context. Legitimate policy-covered work remains possible.
- **A2:** the owner changes the question after the card was sent. The old card is void and cannot be answered.
- **A3:** revoke the CRM token before dispatch: the known-unexecuted update is denied/held without claiming it happened. Separately lose the response after possible commit: the update is UNKNOWN, gets a named reconciliation path and is never blindly resent. The brief distinguishes the two.

**Pass.** All three conditions hold:

- the share handled without a person is reported;
- every exception has its reason;
- the side-by-side review with the maintainer is approved.
