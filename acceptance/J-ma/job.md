# Acceptance job J-ma: parallel-work base (slice 2)

**Runs on:** the successor's **installed** app, on a fresh test Home, plus a paired test phone.

**Held out.**

**Result:** `result.json` in this folder, written when the job runs, with the same schema as J-01.

## Phases

| # | Step | Observes | R-IDs |
|---|---|---|---|
| 1 | Pair the phone (QR code plus a short code) | Paired device listed, with Revoke | R-UX-PHONE-01 |
| 2 | Give one goal; the parent starts two children and invites a reviewer | Children nest under the parent, each in its own worktree. The invite card shows Review only / Add to thread / Not now and who pays | R-MA-01, R-MA-08, R-WT-01 |
| 3 | Open split view both ways: chat beside Changes, then child session beside child session | Both layouts work and are restored after a restart | R-UX-SPLIT-01 |
| 4 | Switch the sidebar to attention mode | Status line per thread; needs-you and working counts | R-UX-INBOX-01 |
| 5 | Steer child 1 mid-turn; queue a "send when done" message for child 2 | The steer is applied; the queued message is sent after the turn and not dropped | R-MA-09 |
| 6 | A child raises an approval; answer it **from the phone** | The approval binds the content hash; the child continues | R-UX-PHONE-01, R-GOV-IRREV-01 |
| 7 | The reviewer reviews child 1's diff | Transcript only, no write tools | R-MA-04 |
| 8 | Merge: hand off child 1's worktree to local; merge context back separately | Code arrives only on the person's action; context merge is a separate action | R-MA-07 |
| 9 | Each child ends | Exactly one final report per run: done, failed or blocked | R-MA-06 |
| 10 | Fork the parent into a new worktree | The fork is independent; the original is unchanged | R-WT-01 |

## Adverse cases

- **A1:** a child asks for a wider mode, or tries to start a grandchild. Refused with a named reason (R-MA-03, R-MA-01 depth 1).
- **A2:** kill the app mid-run. On restart each child resumes or is marked interrupted, with no duplicate effect (R-MA-05).
- **A3:** the content changes after a phone approval was given. The approval is void and the action is not taken (R-GOV-IRREV-01).
- **A4:** a revoked phone answers. The answer is refused.
- **A5:** a notification payload carries no content and no action link.

## Parity

- Compared side by side with Codex, Claude and Cursor, by navigation.
- the maintainer approves (R-UX-PARITY-01, O-12).

## Pins

Version and pin fields come from the P-03 second pass.
