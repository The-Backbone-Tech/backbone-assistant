import type { GapKind, SpecGap } from '../../core/coverage.ts';

/**
 * How each J-01 phase and adverse case reaches the journey oracle (the acceptance job's draft:
 * owner-operating-vision/investigations/00-spec-drafts/acceptance-jobs/J-01.md):
 * - `covered`: asserted through the port, as the job states it;
 * - `narrowed`: asserted through the port, but less than the job states (`note` says what);
 * - `deviation`: written as the job states it and run as an expected failure on legacy;
 * - `gap`: the legacy surface cannot express it (see `gaps`);
 * - `out-of-scope`: the job's UI-only part (layout, keyboard, panes, parity), for the app oracle.
 */
export type PhaseStatus = 'covered' | 'narrowed' | 'deviation' | 'gap' | 'out-of-scope';

export interface PhaseCoverage {
  readonly step: string;
  readonly status: PhaseStatus;
  /** Cases that carry it: `file > it` title prefixes (from the property tag to the first colon). */
  readonly oracle?: readonly string[];
  readonly gap?: string;
  readonly note?: string;
}

export const coverage: {
  readonly journey: 'J-01';
  readonly phases: Readonly<Record<string, PhaseCoverage>>;
  readonly gaps: readonly (SpecGap & { kind: GapKind })[];
} = {
  journey: 'J-01',
  phases: {
    '1': {
      step: 'Open the app with no thread selected: one centred input',
      status: 'out-of-scope',
      note: 'Layout only.',
    },
    '2': {
      step: 'Create a project, attach a note and an XLSX through “+”; the original bytes are kept',
      status: 'narrowed',
      oracle: ['brief.test.ts > [V1] phase 2'],
      gap: 'SG-J01-01',
      note: 'The project, the thread’s membership and the workbook’s exact original bytes (SHA-256 and download) are asserted. The note is the person’s own document, created before the message: the legacy composer attaches XLSX originals only. Sidebar and chips are UI.',
    },
    '3': {
      step: 'Pick permission mode, model, effort and “this computer”; ask for an editable brief',
      status: 'narrowed',
      oracle: ['brief.test.ts > [V1] phase 3'],
      note: 'The agent, given the note and the workbook cells (judged from its model input), writes the brief as version 1 by the agent, and the thread asks the person nothing (V1). Mode, model and effort pickers, the turn block and the pinned summary are UI; the scripted agent stands for the chosen model.',
    },
    '4': { step: 'Open Changes, then Files', status: 'out-of-scope', note: 'Panes and keyboard only.' },
    '5': {
      step: 'Edit the brief as a human, then Save: version 2 is the person’s; the file list refreshes without a restart',
      status: 'covered',
      oracle: ['brief.test.ts > [O5] phase 5'],
      gap: 'SG-J01-02',
      note: 'Through the keyed Save the web app uses (private draft, then save-original). Version 1’s words are judged through the observer.',
    },
    '6': {
      step: 'A side chat asked to change the file refuses: read-only tools, no effect',
      status: 'gap',
      gap: 'SG-J01-03',
    },
    '7': {
      step: 'Quit and cold start: thread, unsent text, open tabs restored; no recovery prompt',
      status: 'narrowed',
      oracle: ['brief.test.ts > [O1] phase 7'],
      note: 'The service process is stopped and started: the thread’s answers, writes and project and the brief’s versions are as before. Unsent text and open tabs are the app’s; no recovery prompt is UI.',
    },
    '8': {
      step: 'Follow up in the same thread: the answer uses version 2',
      status: 'covered',
      oracle: ['brief.test.ts > phase 8'],
      note: 'Judged by what the model was given (the brief at version 2 with the person’s words), never by its prose.',
    },
    '9': {
      step: 'Repository task in a scratch repo; Changes on “Uncommitted”; nothing committed without the person',
      status: 'gap',
      gap: 'SG-J01-05',
    },
    '10': {
      step: 'Every file J-01 created is classed original, working or accepted; intermediates hidden',
      status: 'gap',
      gap: 'SG-J01-04',
    },
    A1: {
      step: 'Kill the app during Save: exactly one of {v1, v2} exists, and the app states which',
      status: 'covered',
      oracle: ['save-kill.test.ts > [O1] killed', 'lessons.test.ts > J-L14'],
      gap: 'SG-J01-02',
      note: 'SIGKILL of the service process 0, 1, 3, 6, 12, 25, 50, 100 and 400 ms after the Save request leaves; on legacy the kills fall on both sides of the commit (it landed between 3 and 12 ms in the runs so far). The Save’s state is read back by its own identity, and continuing it never makes a version 3.',
    },
    A2: {
      step: 'Stop during an agent’s write: the outcome shows UNKNOWN and is not resent; the exact copy is denied (R-BASE-04)',
      status: 'deviation',
      oracle: [
        'agent-write.test.ts > [O1][S8] killed at',
        'agent-write.test.ts > [S8] killed once the write has begun',
        'stop.test.ts > [S8] stopped',
        'lessons.test.ts > J-L6',
        'lessons.test.ts > J-L7',
        'lessons.test.ts > J-L8',
      ],
      gap: 'SG-J01-06',
      note: 'Held on legacy: at every crash point and Stop timing the outcome is stated and agrees with the document, recovery and later restarts never resend, and an exact copy under a new key never changes the document twice (after a done write it fails on the version). Deviation: legacy never shows UNKNOWN for the brief, an internal write. An interrupted write reads as dispatching (“in progress”) until its lease and a 30 s grace pass, then the dispatcher inspects the document history and settles it (killed at write.begun: failed, nothing written). The UNKNOWN wording is run as an expected failure.',
    },
    A3: {
      step: 'The side chat tries an effect: refused with a named reason',
      status: 'gap',
      gap: 'SG-J01-03',
    },
    parity: {
      step: 'Phases 1–7 side by side with Codex and Claude, Light and Dark, 375 and 1440 px',
      status: 'out-of-scope',
      note: 'Owner-approved visual parity.',
    },
  },
  gaps: [
    {
      id: 'SG-J01-01',
      kind: 'no-surface',
      summary:
        'A message attaches XLSX originals only (CreateTask.inputFiles); a text note cannot be attached to a message.',
      needs:
        'An attachment crossing for any file kind, keeping its original bytes, named in the message it came with.',
    },
    {
      id: 'SG-J01-02',
      kind: 'no-surface',
      summary:
        'Earlier versions’ words have no API (DocumentView.versions is metadata only); the adapter reads app.document_versions as the observer to judge “v1 kept” and “applied at most once”.',
      needs: 'A person-readable version history with each version’s words (or hash) and author.',
    },
    {
      id: 'SG-J01-03',
      kind: 'no-surface',
      summary:
        'Legacy has no side chat, so neither its read-only tools (phase 6) nor its refused effect (A3) can be asked of it.',
      needs:
        'A side-chat crossing bound to a thread with a read-only tool grant, whose attempted effect is refused with a named reason.',
    },
    {
      id: 'SG-J01-04',
      kind: 'no-surface',
      summary:
        'Documents carry a representation (text, office, original), not a class of original, working or accepted, and nothing marks intermediates as hidden.',
      needs: 'A file class on every stored file, and a listing that hides intermediates.',
    },
    {
      id: 'SG-J01-05',
      kind: 'no-surface',
      summary:
        'The repository task (scratch repo, Uncommitted diff, nothing committed without the person) needs a local working root and repository tooling the journey port does not reach yet.',
      needs: 'A journey port verb for a scratch repository bound to the thread, and its uncommitted diff.',
    },
    {
      id: 'SG-J01-06',
      kind: 'no-surface',
      summary:
        'Killing the service at a point inside an agent’s write uses the legacy test hook BACKBONE_FAILPOINT (effect.proposed, effect.claimed, dispatch.begun, effect.observed); Stop timings cannot reach the instant between proposal and dispatch, which only the held write (J-L8) reaches.',
      needs:
        'A named crash-injection contract for the service process (or a kill harness that pauses at each point of the effect gateway).',
    },
  ],
};
