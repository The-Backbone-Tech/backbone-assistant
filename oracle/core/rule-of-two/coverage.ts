import type { Coverage } from '../coverage.ts';

/**
 * The rule of two: a run that read outside content is marked by the database, nobody lowers the mark,
 * and untrusted, private and outbound together go to an independent checker (read arguments count as
 * outbound). Marks and why are observed as the workspace's system principal (sec.run_reasons), never
 * as the administrator. Adversary cases attack as the tables' owner and observe the result publicly.
 */
export const coverage: Coverage = {
  promise: 'rule-of-two',
  legacyFiles: ['rule-of-two.test.ts', 'read-outbound.test.ts'],
  cases: {
    'rule-of-two.test.ts > a run is marked by what it read, and the database decides > a source from outside the workspace marks the run as having read untrusted content, whatever the recorder says':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/marks.test.ts > a run is marked by what it read, and the database decides > [S6] a source from outside the workspace marks the run as having read untrusted content, whatever the recorder says',
        ],
      },
    'rule-of-two.test.ts > a run is marked by what it read, and the database decides > a person’s words in a private task are private material; a workspace document or a shared task’s are not':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/marks.test.ts > a run is marked by what it read, and the database decides > [S17] a person’s words in a private task are private material; a workspace document or a shared task’s are not',
        ],
      },
    'rule-of-two.test.ts > a run is marked by what it read, and the database decides > a document or a connection marked sensitive is private material wherever it is':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/marks.test.ts > a run is marked by what it read, and the database decides > [S17] a document or a connection marked sensitive is private material wherever it is',
        ],
      },
    'rule-of-two.test.ts > a run is marked by what it read, and the database decides > imported material is untrusted until a person reviews it, whoever edits it':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/marks.test.ts > a run is marked by what it read, and the database decides > [S6] imported material is untrusted until a person reviews it, whoever edits it',
        ],
      },
    'rule-of-two.test.ts > a run is marked by what it read, and the database decides > a person’s own connection is private material until its person says otherwise':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/marks.test.ts > a run is marked by what it read, and the database decides > [S17] a person’s own connection is private material until its person says otherwise',
        ],
      },
    'rule-of-two.test.ts > a run is marked by what it read, and the database decides > a recorded document is exactly what that version held, with the document’s own author and task':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/marks.test.ts > a run is marked by what it read, and the database decides > [S17] a recorded document is exactly what that version held, with the document’s own author and task',
        ],
      },
    'rule-of-two.test.ts > what an agent writes carries what its run had read > an agent’s words written after untrusted content are untrusted to whoever reads them; a person’s edit never lowers that':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/words.test.ts > what an agent writes carries what its run had read > [S17] an agent’s words written after untrusted content are untrusted to whoever reads them; a person’s edit never lowers that',
        ],
      },
    'rule-of-two.test.ts > what an agent writes carries what its run had read > a title an agent’s change writes carries its run’s marks, even when the content stays the same':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/words.test.ts > what an agent writes carries what its run had read > [S17] a title an agent’s change writes carries its run’s marks, even when the content stays the same',
        ],
      },
    'rule-of-two.test.ts > what an agent writes carries what its run had read > private material an agent copies into a shared document stays private material':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/words.test.ts > what an agent writes carries what its run had read > [S17] private material an agent copies into a shared document stays private material',
        ],
      },
    'rule-of-two.test.ts > what an agent writes carries what its run had read > marking a document is not a new version, and a mark changes nothing else':
      {
        status: 'adversary',
        oracle: [
          'rule-of-two/words.test.ts > what an agent writes carries what its run had read > [S17] marking a document is not a new version, and not even the tables’ owner lifts a mark while changing anything else',
        ],
      },
    'rule-of-two.test.ts > memory enters a run only through recall, and marks it > a person’s memory is private material; recalling nothing marks nothing':
      {
        status: 'narrowed',
        oracle: [
          'rule-of-two/memory.test.ts > memory enters a run only through recall, and marks it > [S17] a person’s memory is private material; recalling nothing marks nothing',
        ],
        note: "A session naming the run without its secret stands in for the legacy session of a colleague carrying the run's id; the oracle accepts not_in_run or denied for each refused recall.",
      },
    'rule-of-two.test.ts > memory enters a run only through recall, and marks it > memory written by work that had read untrusted content carries that into every run that recalls it':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/memory.test.ts > memory enters a run only through recall, and marks it > [S17] memory written by work that had read untrusted content carries that into every run that recalls it',
        ],
      },
    'rule-of-two.test.ts > a run starts with what its task’s conversation carries > a follow-up run in the same task starts marked, whatever the session that queues it says':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/memory.test.ts > a run starts with what its task’s conversation carries > [S6] a follow-up run in the same task starts marked, whatever the session that queues it says',
          'rule-of-two/memory.test.ts > nobody lowers a run’s marks > [S6] neither the service nor the tables’ owner clears a mark once raised',
        ],
      },
    'rule-of-two.test.ts > a run starts with what its task’s conversation carries > a routine’s next firing starts with what earlier firings in its task read':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/memory.test.ts > a run starts with what its task’s conversation carries > [S6] a routine’s next firing starts with what earlier firings in its task read',
        ],
      },
    'rule-of-two.test.ts > the rule of two fires on what was read > an external effect of a run that read untrusted content and private material goes to a checker, and the question says why':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/fires.test.ts > the rule of two fires on what was read > [S17] an external effect of a run that read untrusted content and private material goes to a checker, and the question says why',
        ],
      },
    'rule-of-two.test.ts > people mark what is private, through a crossing, in the ledger > anyone who can see a document may mark it; lifting a mark is for its task’s people or an owner or admin; runs do neither':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/marking.test.ts > people mark what is private, through a crossing, in the ledger > [S6] anyone who can see a document may mark it; lifting a mark is for its task’s people or an owner or admin; runs do neither',
        ],
      },
    'rule-of-two.test.ts > people mark what is private, through a crossing, in the ledger > a workspace connection’s mark is lifted by an owner or admin; a person’s own, by that person alone':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/marking.test.ts > people mark what is private, through a crossing, in the ledger > [S6] a workspace connection’s mark is lifted by an owner or admin; a person’s own, by that person alone',
        ],
      },
    'rule-of-two.test.ts > what an agent wrote is lifted only by a person who vouches for it > the people of the document’s task, or an owner or admin, review it through a crossing, in the ledger; runs never':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/marking.test.ts > what an agent wrote is lifted only by a person who vouches for it > [S17] the people of the document’s task, or an owner or admin, review it through a crossing, in the ledger; runs never',
        ],
      },
    'rule-of-two.test.ts > what a run is shown of document titles marks it, or is withheld > titles whose words came from untrusted content are withheld; titles of private material mark the run':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/marking.test.ts > what a run is shown of document titles marks it, or is withheld > [S6] titles whose words came from untrusted content are withheld; titles of private material mark the run',
        ],
      },
    'rule-of-two.test.ts > a person’s words in a private conversation are private material > a run that answers them starts holding them; a shared task’s does not':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/conversation.test.ts > a person’s words in a private conversation are private material > [S17] a run that answers them starts holding them; a shared task’s does not',
        ],
      },
    'rule-of-two.test.ts > a person’s words in a private conversation are private material > an instruction routine’s firing holds its person’s instruction: after untrusted content, a send needs a checker':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/conversation.test.ts > a person’s words in a private conversation are private material > [S17] an instruction routine’s firing holds its person’s instruction: after untrusted content, a send needs a checker',
        ],
      },
    'rule-of-two.test.ts > a person’s words in a private conversation are private material > private material from beyond the conversation is kept apart, and carried to the task’s next run':
      {
        status: 'adversary',
        oracle: [
          'rule-of-two/conversation.test.ts > a person’s words in a private conversation are private material > [S17] private material from beyond the conversation is kept apart, carried to the task’s next run, and not even the tables’ owner lowers it',
        ],
      },
    'rule-of-two.test.ts > the company’s knowledge carries what its words carry > knowledge proposed from untrusted content is untrusted words; a run reads it only through recall, which marks it':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/knowledge.test.ts > the company’s knowledge carries what its words carry > [S17] knowledge proposed from untrusted content is untrusted words; a run reads it only through recall, which marks it',
        ],
      },
    'rule-of-two.test.ts > a digest takes the marks of what it quotes > quoting an effect, a question about it or words a run wrote carries that run’s marks; a private task’s words are private material':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/digest.test.ts > a digest takes the marks of what it quotes > [S17] quoting an effect, a question about it or words a run wrote carries that run’s marks; a private task’s words are private material',
        ],
      },
    'rule-of-two.test.ts > a digest takes the marks of what it quotes > a run never rewrites its task’s title or goal: what quotes a task quotes its people':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/digest.test.ts > a digest takes the marks of what it quotes > [S6] a run never rewrites its task’s title or goal: what quotes a task quotes its people',
        ],
      },
    'rule-of-two.test.ts > publishing inside the workspace is routed like a send > a run marked both ways writing a document others can read goes to a checker; its person’s own private task does not':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/fires.test.ts > publishing inside the workspace is routed like a send > [S17] a run marked both ways writing a document others can read goes to a checker; its person’s own private task does not',
        ],
      },
    'rule-of-two.test.ts > who a task is for is the crossings’ own sentence > the service cannot ask who a task it cannot see is for':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/marking.test.ts > who a task is for is the crossings’ own sentence > [S17] the service cannot ask who a task it cannot see is for',
        ],
      },
    'rule-of-two.test.ts > the carry stays cheap however many runs a task holds > a new run in a task with twenty thousand earlier runs finds the first marked one by index':
      { status: 'gap', gap: 'SG-R2-01' },
    'rule-of-two.test.ts > memory another agent kept is its words until its person accepts it > quoting an imported memory proposal nobody accepted marks the quoting run as having read untrusted content':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/digest.test.ts > memory another agent kept is its words until its person accepts it > [S6] quoting an imported memory proposal nobody accepted marks the quoting run as having read untrusted content',
        ],
      },
    'rule-of-two.test.ts > what a run marked both ways writes where others read it stays with its person > its answer in a shared task is kept for its person; everyone else reads a pointer (probe b2)':
      {
        status: 'adversary',
        oracle: [
          'rule-of-two/kept.test.ts > what a run marked both ways writes where others read it stays with its person > [S17] its answer in a shared task is kept for its person; everyone else reads a pointer (probe b2)',
        ],
      },
    'rule-of-two.test.ts > what a run marked both ways writes where others read it stays with its person > its effects are its person’s and its decider’s; its steps show others only that they happened; it records no promise':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/kept.test.ts > what a run marked both ways writes where others read it stays with its person > [S17] its effects are its person’s and its decider’s; its steps show others only that they happened; it records no promise',
        ],
      },
    'rule-of-two.test.ts > what a run marked both ways writes where others read it stays with its person > later work in the task carries what the conversation shows it: a colleague’s answers are read by all, its person’s next run’s are kept':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/kept.test.ts > what a run marked both ways writes where others read it stays with its person > [S17] later work in the task carries what the conversation shows it: a colleague’s answers are read by all, its person’s next run’s are kept',
        ],
      },
    'rule-of-two.test.ts > what a run marked both ways writes where others read it stays with its person > nothing is held back where only its person reads, or when its only private material is its own conversation’s':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/kept.test.ts > what a run marked both ways writes where others read it stays with its person > [S17] nothing is held back where only its person reads, or when its only private material is its own conversation’s',
        ],
      },
    'rule-of-two.test.ts > a document an effect writes goes into the task its arguments name > the dispatcher cannot write a new document anywhere else (P3-4)':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/belongs.test.ts > a document an effect writes goes into the task its arguments name > [S8] the dispatcher cannot write a new document anywhere else (P3-4)',
        ],
      },
    'rule-of-two.test.ts > the database decides where a recorded source belongs and whose words it holds (P3-5) > a run reads no source its person cannot see; a person is claimed as author only where they could have written':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/belongs.test.ts > the database decides where a recorded source belongs and whose words it holds (P3-5) > [S6] a run reads no source its person cannot see; a person is claimed as author only where they could have written',
        ],
      },
    'rule-of-two.test.ts > a group conversation is never its person’s alone (P2-F) > what should be kept is kept from the first answer; whoever joins later reads the pointer (probe G2)':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/channel.test.ts > a group conversation is never its person’s alone (P2-F) > [S17] what should be kept is kept from the first answer; whoever joins later reads the pointer (probe G2)',
        ],
      },
    'rule-of-two.test.ts > why a run is marked is its person’s (P2-G) > a colleague reads that a run is marked, never why; its person and whoever decides read why (probe G1)':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/kept.test.ts > why a run is marked is its person’s (P2-G) > [S17] a colleague reads that a run is marked, never why; its person and whoever decides read why (probe G1)',
        ],
      },
    'rule-of-two.test.ts > a knowledge proposal from work marked both ways is kept for its person and the verifier (P3-1) > no owner or admin reads it while it waits; the verifier decides; its person may decline it, never accept it (probe I3)':
      {
        status: 'narrowed',
        oracle: [
          'rule-of-two/kept-knowledge.test.ts > a knowledge proposal from work marked both ways is kept for its person and the verifier (P3-1) > [S15] no owner or admin reads it while it waits; the verifier decides; its person may decline it, never accept it (probe I3)',
        ],
        note: "The legacy case reads the candidate's kept_for column and the decision rows as the administrator; the oracle reads the decision as its person and states kept_for by who can and cannot read the proposal (its person and the verifier; not an admin).",
      },
    'rule-of-two.test.ts > a digest never copies why another person’s work is marked (P2-J) > Joan’s tidy-up and brief quote Marta’s work as a mark and a plain reason, never her private title (probes K1, L1)':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/digest.test.ts > a digest never copies why another person’s work is marked (P2-J) > [S17] Joan’s tidy-up and brief quote Marta’s work as a mark and a plain reason, never her private title (probes K1, L1)',
        ],
      },
    'rule-of-two.test.ts > a question put to anyone but the person whose material it is names its kinds, not its titles (P3-3) > an elevation of work marked both ways says what kinds and whose; whoever decides it does not read why (probe K5)':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/fires.test.ts > a question put to anyone but the person whose material it is names its kinds, not its titles (P3-3) > [S17] an elevation of work marked both ways says what kinds and whose; whoever decides it does not read why (probe K5)',
        ],
      },
    'read-outbound.test.ts > external read argument routing > an outside read the workspace classified as a read, its query composed by the model, asks the rule of two and cannot be dispatched':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/read-outbound.test.ts > external read argument routing > [S17] an outside read the workspace classified as a read, its query composed by the model, asks the rule of two and cannot be dispatched',
        ],
      },
    'read-outbound.test.ts > external read argument routing > the same read stays free with one mark only, and an internal read stays free with both':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/read-outbound.test.ts > external read argument routing > [S17] the same read stays free with one mark only, and an internal read stays free with both',
        ],
      },
    'read-outbound.test.ts > external read argument routing > an own OAuth account does not itself admit arbitrary private material in outbound arguments':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/read-outbound.test.ts > external read argument routing > [S17] an own OAuth account does not itself admit arbitrary private material in outbound arguments',
        ],
      },
    'read-outbound.test.ts > external read argument routing > a read that sends no argument stays free; the same read with any argument the model supplied asks':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/read-outbound.test.ts > external read argument routing > [S17] a read that sends no argument stays free; the same read with any argument the model supplied asks',
        ],
      },
    'read-outbound.test.ts > external read argument routing > a first-party tool Backbone does not class as a read is not made one by the catalogue':
      {
        status: 'ported',
        oracle: [
          'rule-of-two/read-outbound.test.ts > external read argument routing > [S17] a first-party tool Backbone does not class as a read is not made one by the catalogue',
        ],
      },
  },
  gaps: [
    {
      id: 'SG-R2-01',
      kind: 'administrative',
      summary:
        'Carrying earlier runs’ marks into a new run stays cheap in a task with twenty thousand earlier runs: the legacy case bulk-writes the runs as the administrator with the run triggers disabled, then reads query plans.',
      needs:
        'A seeding port (or bulk fixture crossing) for many finished runs in one task, and a stated latency budget for queueing a run there; which index serves the carry is the implementation’s own.',
    },
  ],
};
