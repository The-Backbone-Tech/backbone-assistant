# C-ma: parallel work

**Runs on:** the installed app of any distribution, on a fresh data home, plus a paired test device.

## Steps

| # | Step | Observes |
| --- | --- | --- |
| 1 | Pair a device | The device is listed, with Revoke |
| 2 | Give one goal; the parent starts two children and invites a reviewer | Children nest under the parent, each in its own worktree; the reviewer's mode is review only |
| 3 | Steer one child mid-turn; queue a message for the other | The steer applies; the queued message is sent after the turn, not dropped |
| 4 | A child raises an approval; answer it from the device | The approval binds the content hash; the child continues (I-18) |
| 5 | The reviewer reviews a child's diff | Transcript only, no write tools (I-14) |
| 6 | Merge a child's work | Code arrives only on the person's action; the context merge is a separate action |
| 7 | Each child ends | Exactly one final report per run: done, failed or blocked |

## Adverse cases

- **A1:** a child asks for a wider mode, or starts a grandchild. Refused with a named reason (I-3, I-14).
- **A2:** kill the app mid-run. Each child resumes or is marked interrupted; no effect is duplicated (I-6).
- **A3:** the content changes after an approval was given. The approval is void (I-18).
- **A4:** a revoked device answers. The answer is refused.
- **A5:** a notification carries no content and no action link.
