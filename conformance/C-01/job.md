# C-01: one thread

**Runs on:** the installed app of any distribution, on a fresh data home. It never touches a person's default profile. The app's journeys in `packages/surfaces/app/e2e/` run these steps headless.

## Steps

| # | Step | Observes |
| --- | --- | --- |
| 1 | Open the app with no thread selected | One centred input |
| 2 | Create a project; attach a note and a spreadsheet | The project is listed; the originals' bytes are kept unchanged |
| 3 | Ask for an editable brief | The agent's write is proposed through the effect gateway and carried; the brief is version 1, by the agent |
| 4 | Edit the brief as a person, then Save | Version 2 is owned by the person; the file list refreshes without a restart |
| 5 | A side chat is asked to change the file | It refuses: read-only tools, no effect |
| 6 | Quit and cold start | Thread, unsent text and open tabs come back; no recovery prompt |
| 7 | Follow up in the same thread | The answer uses version 2 |

## Adverse cases

- **A1:** kill the app during Save. Afterwards exactly one of {v1, v2} exists, and the app says which (I-6).
- **A2:** stop during an agent's write. The outcome is UNKNOWN and is not resent; the exact copy is refused (I-6).
- **A3:** the side chat tries an effect. It is refused with a named reason (I-11, I-13).
