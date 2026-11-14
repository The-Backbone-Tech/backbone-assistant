/**
 * Where each lesson of transition-lists §3 is enforced. Only lessons about what a running target
 * does belong to this oracle; the rest are rules of the successor repository or of the behaviour
 * oracle, named so nothing is lost between them.
 */
export type Home =
  | 'core oracle' // a case in lessons/cases.ts, shown failing first on the stub
  | 'core oracle (ported cases)' // kept by ported legacy cases; no separate lesson case
  | 'behaviour oracle' // the next task: evals, CLI lifecycle, journeys
  | 'repository rule' // a structural check or practice in the successor repository, not a target behaviour
  | 'oracle convention'; // how this suite itself is written and checked

export const REGISTER: readonly { lesson: number; home: Home; where: string }[] = [
  { lesson: 1, home: 'repository rule', where: 'One definition per database function: a CI check in the successor.' },
  { lesson: 2, home: 'repository rule', where: 'No text-patched function bodies; every migration runs on a fresh database in CI.' },
  { lesson: 3, home: 'repository rule', where: 'Frozen migrations: a checksum test.' },
  { lesson: 4, home: 'repository rule', where: 'Same as lesson 1.' },
  { lesson: 5, home: 'behaviour oracle', where: 'No case yet: an upgrade with work in flight needs two builds of the target (SG-LIF-05, behaviour/lifecycle/lessons.ts).' },
  { lesson: 6, home: 'behaviour oracle', where: 'J-L6 (behaviour/journey): recovery after a kill mid-write never resends; the order itself is not observable through a refused restore (SG-LIF-06).' },
  { lesson: 7, home: 'core oracle', where: 'L7a (connector change) holds on legacy; L7b (any external change) is a known legacy deviation; J-L7 (a killed write’s exact copy is never applied twice) holds.' },
  { lesson: 8, home: 'core oracle', where: 'L8a (revoked after claim), L8b (expired after claim); effects/recovery and the lock-wait cases; J-L8 (a Stop while a write is held is honoured before sending).' },
  { lesson: 9, home: 'core oracle', where: 'L9: listed with resolver, evidence and deadline; a known legacy deviation (no resolver, no deadline).' },
  { lesson: 10, home: 'core oracle', where: 'L10 and isolation/catalog (every store walled, the inventory catches an unwalled one). The export-classification half belongs to the portability oracle.' },
  { lesson: 11, home: 'behaviour oracle', where: 'behaviour/scenes: all 75 legacy attack scenarios restated and judged from effects; the rule-of-two cases in core are the database half.' },
  { lesson: 12, home: 'repository rule', where: 'Explicit security-relevant order in PL/pgSQL: a review checklist item, not observable through a crossing.' },
  { lesson: 13, home: 'behaviour oracle', where: 'L13a (import twice) and L13b (restore twice) in behaviour/lifecycle; erasure across every store is still the portability oracle’s (forgotten memory stays forgotten is in isolation/catalog).' },
  { lesson: 14, home: 'oracle convention', where: 'behaviour/scenes/lessons.test.ts (the scene judge catches harm that is not a leak; a leak-only judge misses it) and J-L14 (a Save is judged by stored versions, not reported state).' },
  { lesson: 15, home: 'oracle convention', where: 'core/imports.test.ts: cases import no legacy package, driver or adapter binding.' },
  { lesson: 16, home: 'repository rule', where: 'One full gate; branch protection.' },
  { lesson: 17, home: 'behaviour oracle', where: 'L17 in behaviour/lifecycle: a known legacy deviation (no test-run guard; with no BACKBONE_HOME the CLI resolves and migrates $HOME/.backbone/default).' },
  { lesson: 18, home: 'repository rule', where: 'No vendor version strings in core paths: a pattern ban.' },
  { lesson: 19, home: 'repository rule', where: 'ADRs record decisions; docs never claim what is not built.' },
  { lesson: 20, home: 'repository rule', where: 'Evidence outside the repository; size limits; small daily commits.' },
  { lesson: 21, home: 'repository rule', where: 'One integrator owns the core; commit trailers name the agent.' },
  { lesson: 22, home: 'repository rule', where: 'One real job before scope widens; debt limits start at zero.' },
];
