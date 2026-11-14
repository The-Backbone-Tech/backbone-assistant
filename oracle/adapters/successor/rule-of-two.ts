import { createHash, randomUUID } from 'node:crypto';
import type { Attack } from './attacks.ts';
import { type Bindings, type Client, composite, direct, first, fn, fnRows, json, scalar, view, ws } from './binding.ts';

/** Crossings only the rule-of-two cases use. */
export const ruleOfTwo: Bindings = {
  // --- tasks and conversations ----------------------------------------------------------------------
  'r2.task.share': fn('SELECT gov.share_task($1)', (a) => [a.task]),
  'r2.task.rewrite': fn('SELECT gov.rewrite_task($1, $2, $3, $4)', (a) => [a.task, a.title ?? null, a.goal ?? null, a.status ?? null]),
  'r2.task.people': fn('SELECT gov.task_people($1)', (a) => [a.task]),
  'r2.conversation.say': fn('SELECT gov.post_message($1, $2, $3)', (a, actor) => [a.task, actor.principal ?? null, a.content]),
  'r2.conversation.answer': fn('SELECT gov.answer_in_conversation($1, $2, $3)', (a) => [a.task, a.agent, a.content]),

  // --- runs -------------------------------------------------------------------------------------------
  /** A run queued with marks the session states: the marks are not the service's to write. */
  'r2.run.queue_stating_marks': direct(async (c, a, actor) =>
    scalar(
      c,
      `INSERT INTO app.runs (workspace_id, task_id, agent_id, mandate_id, tainted_untrusted, tainted_sensitive)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [ws(actor), a.task, a.agent, a.mandate, a.untrusted ?? false, a.sensitive ?? false],
    ),
  ),
  /** A run's marks lowered directly, as the service. */
  'r2.run.lower_marks': direct(async (c, a) =>
    (await c.query('UPDATE app.runs SET tainted_untrusted = false, tainted_sensitive = false WHERE id = $1', [a.run])).rowCount,
  ),
  'r2.run.step.titled': composite(async (c, a) => {
    await c.query('SELECT gov.write_step($1, $2, $3, $4, $5::jsonb, $6)', [a.run, a.seq, a.kind ?? 'tool', a.title, json(a.input ?? {}), a.fence]);
    return null;
  }),
  'r2.marks.quote': composite(async (c, a) => {
    await c.query('SELECT gov.quote_marks($1, $2::jsonb)', [a.run, json(a.quotes)]);
    return null;
  }),
  'r2.commitment.record': fn('SELECT gov.record_commitment($1, $2, $3, $4, $5, $6::smallint)', (a) => [
    a.task,
    a.agent,
    a.to ?? null,
    a.text,
    a.due ?? null,
    a.priority ?? 3,
  ]),
  'r2.tidy.run': fnRows('SELECT finding_kind AS kind FROM gov.tidy_up()', () => []),

  // --- routines -----------------------------------------------------------------------------------------
  'r2.routine.create': fn('SELECT gov.create_routine($1, $2, $3, $4, $5, $6, $7::smallint, $8)', (a) => [
    a.agent,
    a.kind ?? 'instruction',
    a.title ?? 'Weekly vendor digest',
    a.instruction ?? 'Summarise what changed with our vendors this week.',
    a.schedule ?? '0 9 * * 1',
    a.timezone ?? 'Europe/Madrid',
    a.ceiling ?? null,
    new Date(Date.now() + 30 * 86_400_000),
  ]),
  'r2.routine.run_now': fn('SELECT gov.run_routine_now($1)', (a) => [a.routine]),

  // --- documents ----------------------------------------------------------------------------------------
  'r2.document.write': fn('SELECT gov.create_document($1, $2, $3, NULL)', (a) => [a.task ?? null, a.title, a.content]),
  'r2.document.edit': fn('SELECT gov.revise_document($1, $2, $3, $4)', (a) => [a.document, a.title ?? null, a.content ?? null, a.append ?? null]),
  'r2.document.dispatch_write': composite(async (c, a) => {
    await c.query('SELECT gov.write_document_by_effect($1, $2, $3, $4, $5, $6)', [a.effect, a.document, a.title, a.content, a.create ?? false, a.task ?? null]);
    return null;
  }),
  'r2.document.mark': fn('SELECT gov.mark_document($1, $2)', (a) => [a.document, a.sensitive]),
  'r2.document.review': fn('SELECT gov.review_document($1)', (a) => [a.document]),
  'r2.document.list': fnRows('SELECT id, title FROM gov.list_documents($1, $2, $3)', (a) => [a.run, a.words ?? [], a.limit ?? 50]),

  // --- sources a run reads --------------------------------------------------------------------------------
  'r2.source.read_document': fn('SELECT gov.read_document($1, $2)', (a) => [a.run, a.document]),
  /** A recorder stating a document read itself: the core records what that version held instead. */
  'r2.source.record_document_as': fn('SELECT gov.read_document($1, $2, $3, $4)', (a) => [a.run, a.document, a.version ?? 1, a.content]),
  /** A source of a kind that names its subject, recorded without naming it. */
  'r2.source.record_unnamed': fn("SELECT gov.record_source($1, 'unnamed', 'y', NULL, NULL, NULL)", (a) => [a.kind]),
  'r2.source.server_answer': composite(async (c, a) => {
    // The oracle supplies one controlled in-memory observation. Preserve its exact text and
    // actor transaction; this fixture claims no SDK invocation, provider or model receipt.
    const material = `oracle-mcp-${randomUUID()}`;
    const readKey = createHash('sha256').update(material).digest('hex');
    const original = typeof a.content === 'string' ? createHash('sha256').update(Buffer.from(a.content, 'utf8')).digest('hex') : null;
    return scalar(c, `SELECT episode_id FROM gov.record_material_source_read(
      $1::text,$2::text,1,0,$3::text,$4::text,$5::jsonb,'mcp',$6::text,$6::text,NULL,$7::uuid,NULL,$8::uuid,$9::text)`, [
      'oracle-controlled-mcp', material, readKey, original,
      json({ kind: 'oracle-controlled-mcp-read', version: '1', original: 'utf8-source-text', episode: 'identity', prepared: 'identity' }),
      a.content, a.run, a.connection, a.tool ?? 'read_inbox',
    ]);
  }),

  // --- connections ------------------------------------------------------------------------------------------
  'r2.connection.add': fn(`SELECT gov.register_connection($1, $2, 'https://mcp.example/' || $2, $3, 'none')`, (a) => [a.name, a.slug, a.scope ?? 'workspace']),
  'r2.connection.mark': fn('SELECT gov.mark_connection($1, $2)', (a) => [a.connection, a.sensitive]),
  'r2.connection.add_first_party': fn('SELECT gov.register_first_party_connection($1, $2, $3)', (a) => [a.profile, a.slug, a.scope]),
  'r2.connection.sign_in': fn('SELECT gov.sign_in_connection($1, $2, $3)', (a) => [a.connection, a.url, a.scopes]),
  /** The successor creates each workspace's digest key with the workspace: nothing to install. */
  'r2.workspace.install_key': composite(async () => null),

  // --- memory, imports and knowledge --------------------------------------------------------------------------
  'r2.memory.remember': fn('SELECT gov.write_memory($1, $2, $3, $4)', (a) => [a.owner, a.agent, a.content, a.step ?? null]),
  'r2.memory.decide_proposal': fn('SELECT gov.decide_memory_proposal($1, $2)', (a) => [a.proposal, a.accept]),
  'r2.material.import': fn('SELECT gov.import_material($1, $2, $3::jsonb)', (a) => [
    a.person,
    a.source ?? 'openclaw',
    json({ documents: a.documents ?? [], memories: a.memories ?? [], notice: a.notice ?? 'Imported from OpenClaw.' }),
  ]),
  'r2.knowledge.recall': fnRows('SELECT statement FROM gov.recall_knowledge($1, $2, $3)', (a) => [a.run, a.words ?? [], a.limit ?? 30]),

  // --- channels -----------------------------------------------------------------------------------------------
  'r2.channel.register_account': fn('SELECT gov.register_channel_account($1, $2, $3)', (a) => [a.platform ?? 'slack', a.team, a.name ?? 'Acme']),
  'r2.channel.request_pairing': fn('SELECT gov.request_pairing($1, $2, $3)', (a) => [a.account, a.externalId, a.link]),
  'r2.channel.complete_pairing': fn('SELECT gov.complete_pairing($1)', (a) => [a.link]),
  'r2.channel.start_thread': composite(async (c: Client, a) => {
    const row = await first<{ task_id: string; thread_id: string }>(c, 'SELECT * FROM gov.start_channel_thread($1, $2, $3, $4, $5, $6, $7)', [
      a.title ?? 'Conversation',
      a.content,
      a.account,
      a.channel,
      a.thread,
      a.kind ?? 'group',
      a.identity,
    ]);
    return { task: row?.task_id, thread: row?.thread_id };
  }),
  'r2.channel.join_thread': fn('SELECT gov.join_channel_thread($1, $2)', (a) => [a.thread, a.identity]),
};

/** Reads only the rule-of-two cases make. */
export const ruleOfTwoViews: Bindings = {
  'r2.run.reasons': view('SELECT untrusted, sensitive, elsewhere FROM gov.run_reasons($1)', (a) => [a.run]),
  /** One reason column of a run read straight from the run: the reasons are not the service's to read. */
  'r2.run.reason_column': {
    kind: 'view',
    run: async (c, a) => {
      const column = { untrusted: 'untrusted_source', sensitive: 'sensitive_source', elsewhere: 'elsewhere_source' }[String(a.reason)];
      if (!column) throw new Error(`not a reason: ${String(a.reason)}`);
      return (await c.query(`SELECT ${column} AS reason FROM app.runs WHERE id = $1`, [a.run])).rows;
    },
  },
  'r2.source': view('SELECT id, trust, sensitive, authored_by AS "authoredBy", task_id AS task FROM app.episodes WHERE id = $1', (a) => [a.id]),
  'r2.document': view(
    `SELECT id, title, content, version, task_id AS task, content_author AS "contentAuthor", sensitive,
            words_untrusted AS "wordsUntrusted", words_sensitive AS "wordsSensitive", imported
     FROM app.documents WHERE ($1::uuid IS NULL OR id = $1) AND ($2::uuid IS NULL OR task_id = $2) ORDER BY created_at`,
    (a) => [a.id ?? null, a.task ?? null],
  ),
  'r2.document.versions': view('SELECT version, words_untrusted AS "wordsUntrusted" FROM app.document_versions WHERE document_id = $1 ORDER BY version', (a) => [
    a.document,
  ]),
  'r2.connection': view('SELECT id, sensitive FROM app.connections WHERE id = $1', (a) => [a.id]),
  'r2.decision.asked': view(
    `SELECT id, checker_kind AS "checkerKind", checker_id AS checker, reason, question, status, answered_by AS "answeredBy"
     FROM app.decisions WHERE ($1::uuid IS NULL OR id = $1) AND ($2::uuid IS NULL OR subject_id = $2) ORDER BY created_at`,
    (a) => [a.id ?? null, a.subject ?? null],
  ),
  'r2.memory.carried': view('SELECT id, content, words_untrusted AS "wordsUntrusted" FROM app.memory ORDER BY created_at'),
  'r2.memory.proposal': view('SELECT id, content FROM app.memory_proposals ORDER BY created_at, path, line'),
  'r2.knowledge.candidate': view(
    `SELECT id, statement, words_untrusted AS "wordsUntrusted" FROM app.knowledge_candidates
     WHERE ($1::uuid[] IS NULL OR id = ANY ($1)) ORDER BY created_at`,
    (a) => [a.ids ?? (a.id ? [a.id] : null)],
  ),
  'r2.knowledge.carried': view(
    'SELECT statement, words_untrusted AS "wordsUntrusted" FROM app.knowledge WHERE ($1::uuid IS NULL OR candidate_id = $1) ORDER BY created_at',
    (a) => [a.candidate ?? null],
  ),
  'r2.message': view(
    `SELECT role, content, only_for AS "onlyFor" FROM app.messages
     WHERE task_id = $1 AND ($2::uuid IS NULL OR run_id = $2) ORDER BY created_at, id`,
    (a) => [a.task, a.run ?? null],
  ),
  'r2.task.steps': view('SELECT title, summary FROM gov.task_steps($1) WHERE run_id = $2 ORDER BY seq', (a) => [a.task, a.run]),
  'r2.channel.outbound': view(
    `SELECT m.content FROM app.channel_messages cm JOIN app.messages m ON m.workspace_id = cm.workspace_id AND m.id = cm.message_id
     WHERE cm.thread_id = $1 AND cm.direction = 'outbound' ORDER BY cm.created_at`,
    (a) => [a.thread],
  ),
};

/** Run one statement below every grant inside a transaction that is always rolled back; report what the database said. */
async function belowGrants(admin: Client, workspace: string, sql: string, params: unknown[]) {
  await admin.query('BEGIN');
  try {
    await admin.query(`SELECT set_config('backbone.workspace', $1, true)`, [workspace]);
    const { rowCount } = await admin.query(sql, params);
    return { refused: null, rows: rowCount };
  } catch (error) {
    return { refused: (error as Error).message, rows: 0 };
  } finally {
    await admin.query('ROLLBACK');
  }
}

/** Attacks only the rule-of-two cases make: lowering what a run or a document's words carry. */
export const ruleOfTwoAttacks: Record<string, Attack> = {
  'r2.run.clear_marks': (c, a) =>
    belowGrants(c, String(a.workspace), 'UPDATE app.runs SET tainted_untrusted = false, tainted_sensitive = false WHERE id = $1', [a.run]),
  'r2.run.clear_elsewhere': (c, a) => belowGrants(c, String(a.workspace), 'UPDATE app.runs SET elsewhere_source = NULL WHERE id = $1', [a.run]),
  'r2.document.unmark_and_rewrite': (c, a) =>
    belowGrants(c, String(a.workspace), `UPDATE app.documents SET sensitive = false, content = 'v2' WHERE id = $1`, [a.document]),
  'r2.message.unkeep': (c, a) =>
    belowGrants(c, String(a.workspace), `UPDATE app.messages SET only_for = NULL WHERE task_id = $1 AND role = 'agent'`, [a.task]),
};
