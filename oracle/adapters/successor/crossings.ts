import { randomUUID } from 'node:crypto';
import { type Bindings, type Client, composite, direct, first, fn, fnRow, fnRows, json, merge, scalar, ws } from './binding.ts';
import { ruleOfTwo } from './rule-of-two.ts';

const inAnHour = () => new Date(Date.now() + 3_600_000);
const num = (v: unknown) => (v === null || v === undefined ? v : Number(v));

/** What the session holds and sees right after a crossing that chose a workspace for itself. */
async function residue(c: Client, store: string) {
  return first<{ workspace: string; principal: string; visible: number }>(
    c,
    `SELECT current_setting('backbone.workspace', true) AS workspace, current_setting('backbone.principal', true) AS principal,
            (SELECT count(*)::int FROM app.${store}) AS visible`,
  );
}

const core: Bindings = {
  // --- identity and tenancy ---------------------------------------------------------------------
  'workspace.create_first': fnRows(
    'SELECT workspace_id AS workspace, owner_id AS owner, system_id AS system FROM gov.create_workspace($1, $2, $3, $4)',
    (a) => [a.name, a.kind ?? 'team', a.ownerName ?? 'Owner', a.ownerEmail ?? 'owner@example.com'],
  ),
  'workspace.set_delay_window': fn('SELECT gov.set_delay_window($1)', (a) => [a.ms]),
  'person.add': fn('SELECT gov.identity_add_person($1, $2, $3)', (a) => [
    a.name,
    a.email ?? `${String(a.name).toLowerCase().replace(/\W+/g, '.')}@example.com`,
    a.role ?? 'member',
  ]),
  'agent.create': fn('SELECT gov.create_agent($1, $2)', (a) => [a.name, a.role ?? 'worker']),
  'identity.whoami': composite(async (c) => first(c, 'SELECT principal, on_behalf_of AS "onBehalfOf", run FROM gov.whoami()')),

  // --- mandates -----------------------------------------------------------------------------------
  'mandate.issue': fn(
    // This core asks what carries a root mandate's work; the promise tests' work is the person's own (direct).
    'SELECT gov.issue_mandate($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::smallint, $8, $9, $10, $11, $12, $13)',
    (a) => [
      a.subject,
      a.parent ?? null,
      json(a.projects ?? '*'),
      json(a.connections ?? '*'),
      json(a.tools ?? '*'),
      json(a.operations ?? '*'),
      a.ceiling === undefined ? 4 : a.ceiling,
      a.maxTokens ?? null,
      a.maxCostMicros ?? null,
      a.maxDurationMs ?? null,
      a.maxEffects ?? null,
      a.expiresAt === undefined ? inAnHour() : a.expiresAt,
      a.parent ? null : 'direct',
    ],
  ),
  'mandate.revoke': fn('SELECT gov.revoke_mandate($1)', (a) => [a.mandate]),
  'policy.attenuate': fn('SELECT sec.attenuate($1::jsonb, $2::jsonb)', (a) => [json(a.parent), json(a.requested)]),

  // --- tasks and runs -----------------------------------------------------------------------------
  'task.create': fn('SELECT gov.create_task($1, $2, $3, NULL, $4, $5, $6)', (a) => [
    a.requestedBy,
    a.onBehalfOf ?? a.requestedBy,
    a.title ?? 'Find out where the rollout stands',
    a.visibility ?? null,
    a.kind ?? 'task',
    a.workspace ?? null,
  ]),
  'run.queue': fn('SELECT gov.queue_run($1, $2, $3)', (a) => [a.task, a.agent, a.mandate]),
  'run.claim': composite(async (c, a) => {
    const row = await first<{ fence: string; secret: string }>(c, 'SELECT fence, secret FROM gov.claim_run($1, $2, $3, $4)', [
      a.run,
      a.worker ?? 'worker-1',
      a.leaseMs ?? 60_000,
      'direct',
    ]);
    return row ? { fence: Number(row.fence), secret: row.secret } : null;
  }),
  'run.claim_next': composite(async (c, a) => {
    const row = await first<{ workspace_id: string; run_id: string; fence: string; secret: string }>(
      c,
      "SELECT * FROM gov.claim_next_run($1, $2, 'direct')",
      [a.worker ?? 'worker-1', a.leaseMs ?? 60_000],
    );
    return row ? { workspace: row.workspace_id, run: row.run_id, fence: Number(row.fence), secret: row.secret } : null;
  }),
  'run.finish': fn('SELECT gov.finish_run($1, $2, $3)', (a) => [a.run, a.fence, a.outcome ?? 'succeeded']),
  'run.park': fn('SELECT gov.park_run($1, $2)', (a) => [a.run, a.fence]),
  'run.renew_lease': fn('SELECT gov.renew_run_lease($1, $2, $3)', (a) => [a.run, a.fence, a.leaseMs]),
  'run.record_usage': fn('SELECT gov.record_usage($1, $2, $3, $4)', (a) => [a.run, a.fence, a.tokensIn ?? 0, a.tokensOut ?? 0]),
  'run.standing': fn('SELECT gov.run_standing($1)', (a) => [a.run]),
  'run.step.write': composite(async (c, a) => {
    await c.query('SELECT gov.write_step($1, $2, $3, NULL, $4::jsonb, $5)', [a.run, a.seq ?? null, a.kind ?? 'wait', json(a.input ?? {}), a.fence]);
    return null;
  }),
  'run.step.complete': fn('SELECT gov.complete_step($1, $2, $3::jsonb)', (a) => [a.run, a.seq, json(a.output ?? { ok: true })]),

  // --- memory ---------------------------------------------------------------------------------------
  'memory.write': fn('SELECT gov.write_memory($1, $2, $3, NULL, $4)', (a) => [a.owner, a.agent, a.content, a.workspace ?? null]),
  'memory.recall': fnRows('SELECT id, content FROM gov.recall_memory($1, $2)', (a) => [a.run, a.limit ?? 200]),
  'memory.forget': fn('SELECT gov.forget_memory($1)', (a) => [a.memory]),

  // --- effects --------------------------------------------------------------------------------------
  'effect.propose': fn(
    'SELECT gov.propose_effect($1, $2, $3, $4, $5, $6, NULL, $7::smallint, $8, $9::jsonb, $10, NULL, $11)',
    (a) => [
      a.run,
      a.fence,
      a.step ?? 1,
      a.tool ?? 'call',
      a.operation ?? 'crm:update_deal',
      a.connection === undefined ? 'crm' : a.connection,
      a.classHint ?? null,
      a.externalHint ?? null,
      a.args === null ? null : json(a.args ?? { field: 'stage', value: 'won' }),
      a.description ?? 'Set the deal stage to won',
      a.idempotencyKey ?? `idem-${randomUUID()}`,
    ],
  ),
  'effect.claim': fn('SELECT gov.claim_effect($1, $2)', (a) => [a.effect, a.leaseMs ?? 30_000]),
  'effect.claim_next': composite(async (c, a) => {
    const row = await first<{ workspace_id: string; effect_id: string; claim_token: string; stale: boolean; system_id: string }>(
      c,
      'SELECT * FROM gov.claim_next_effect($1, $2)',
      [a.worker ?? 'dispatcher-1', a.leaseMs ?? 30_000],
    );
    return row ? { workspace: row.workspace_id, effect: row.effect_id, claim: row.claim_token, stale: row.stale, system: row.system_id } : null;
  }),
  'effect.begin_dispatch': fn('SELECT gov.begin_dispatch($1, $2)', (a) => [a.effect, a.claim]),
  'effect.observe': fn('SELECT gov.observe_effect($1, $2, $3, $4, $5, $6)', (a) => [
    a.effect,
    a.claim,
    a.outcome,
    a.externalRef ?? null,
    a.observationHash ?? 'obs-hash-1',
    a.note ?? null,
  ]),
  'effect.reconcile': fn('SELECT gov.reconcile_effect($1, $2, $3, $4, $5)', (a) => [
    a.effect,
    a.outcome,
    a.externalRef ?? null,
    a.observationHash ?? null,
    a.note ?? null,
  ]),
  'effect.cancel': fn('SELECT gov.cancel_effect($1, $2)', (a) => [a.effect, a.reason ?? 'not now']),
  'effect.propose_undo': fn('SELECT gov.propose_undo($1, $2::jsonb, $3, $4, $5)', (a) => [
    a.effect,
    json(a.args ?? {}),
    a.description ?? 'Undo',
    a.expectedVersion ?? null,
    a.idempotencyKey ?? `idem-${randomUUID()}`,
  ]),
  'operations.classify': composite(async (c, a) => {
    const row = await first<{ change_id: string; decision_id: string | null }>(c, 'SELECT * FROM gov.classify_operations($1::jsonb)', [
      json(a.changes),
    ]);
    return { change: row?.change_id, decision: row?.decision_id ?? null };
  }),
  'policy.route': fn('SELECT sec.route_effect($1::smallint, $2, $3::smallint, $4, $5, $6, $7)', (a) => [
    a.effectClass,
    a.standing,
    a.ceiling,
    a.untrustedInput,
    a.sensitiveData,
    a.externalParty,
    a.outboundFixed,
  ]),
  'policy.route_unstated': fn('SELECT sec.route_effect($1::smallint, $2, $3::smallint, $4, $5, $6)', (a) => [
    a.effectClass,
    a.standing,
    a.ceiling,
    a.untrustedInput,
    a.sensitiveData,
    a.externalParty,
  ]),
  'policy.transition_allowed': fn('SELECT sec.effect_transition_allowed($1, $2)', (a) => [a.from, a.to]),

  // --- decisions --------------------------------------------------------------------------------------
  'decision.answer': fn('SELECT gov.answer_decision($1, $2, $3, $4)', (a) => [
    a.decision,
    a.proposalHash,
    a.verdict ?? 'approved',
    a.note === undefined ? 'checked' : a.note,
  ]),
  'decision.may_decide': fn('SELECT gov.may_decide($1)', (a) => [a.decision]),
  'decision.escalate': fn('SELECT gov.escalate_decision($1, $2)', (a) => [a.decision, a.note]),
  /** A verifier's answer: the core persists the verifier's verdict as its proof, then carries it out. */
  'verifier.answer': fn('SELECT gov.verifier_answer($1, $2, $3)', (a) => [a.decision, a.verdict ?? 'approved', a.reason ?? 'checked']),

  // --- sources and knowledge ---------------------------------------------------------------------------
  // Promotion fixtures use permitted message evidence; explicit source-kind adversaries stay unchanged.
  'source.record': fn("SELECT gov.record_source('message', $1, $2, $3, $4, $5, 'trusted')", (a) => [
    a.ref ?? 'drive://plan.docx',
    a.content,
    a.authoredBy ?? null,
    a.run ?? null,
    a.task ?? null,
  ]),
  'knowledge.propose_candidate': fn('SELECT gov.propose_candidate($1, $2::jsonb, $3, $4)', (a) => [
    a.statement,
    json(a.evidence),
    a.proposedBy,
    a.topic ?? 'launch',
  ]),
  'knowledge.request_promotion': fn('SELECT gov.request_promotion($1, $2, $3, $4)', (a) => [
    a.candidate,
    a.owner,
    a.validFrom ?? null,
    a.validTo ?? null,
  ]),
  'knowledge.retract': fn('SELECT gov.retract_knowledge($1, $2)', (a) => [a.knowledge, a.reason]),

  // --- the ledger ----------------------------------------------------------------------------------------
  'ledger.verify': composite(async (c) => num(await scalar(c, 'SELECT gov.verify_ledger()'))),
  'ledger.head': composite(async (c) => {
    const row = await first<{ seq: string; hash: string }>(c, 'SELECT * FROM gov.ledger_head()');
    return row ? { seq: Number(row.seq), hash: row.hash } : null;
  }),
  'ledger.verify_anchor': fn('SELECT gov.verify_ledger_anchor($1, $2)', (a) => [a.seq, a.hash]),
};

const isolation: Bindings = {
  'iso.message.post': fn('SELECT gov.post_message($1, $2, $3, $4)', (a) => [a.task, a.author, a.content, a.workspace ?? null]),
  /** Retitle a task by id, or every task the session sees in the workspace named. Returns how many changed. */
  'iso.task.retitle': composite(async (c, a) => {
    const ids: string[] = a.task
      ? [String(a.task)]
      : (await c.query<{ id: string }>('SELECT id FROM app.tasks WHERE workspace_id = $1', [a.workspace])).rows.map((r) => r.id);
    let changed = 0;
    for (const id of ids) changed += Number(await scalar(c, 'SELECT gov.rewrite_task($1, $2, NULL, NULL)', [id, a.title]));
    return changed;
  }),
  'iso.workspace.create_first_and_look': composite(async (c, a) => {
    const created = await first<{ workspace_id: string }>(c, 'SELECT workspace_id FROM gov.create_workspace($1, $2, $3, $4)', [
      a.name,
      a.kind ?? 'team',
      a.ownerName ?? 'Me',
      a.ownerEmail ?? 'me@example.com',
    ]);
    const { rows } = await c.query<{ id: string }>('SELECT id FROM app.workspaces');
    return { created: created?.workspace_id, visible: rows.map((r) => r.id) };
  }),
  'iso.run.claim_next_and_look': composite(async (c, a) => {
    const { rows } = await c.query("SELECT workspace_id AS workspace, run_id AS run FROM gov.claim_next_run($1, 60000, 'direct')", [a.worker ?? 'worker-x']);
    return { claimed: rows, after: await residue(c, 'runs') };
  }),
  'iso.effect.claim_next_and_look': composite(async (c, a) => {
    const { rows } = await c.query(
      'SELECT workspace_id AS workspace, effect_id AS effect, stale, system_id AS system FROM gov.claim_next_effect($1, 30000)',
      [a.worker ?? 'dispatcher-x'],
    );
    return { claimed: rows, after: await residue(c, 'effects') };
  }),
  'iso.invitation.info': fnRows('SELECT * FROM gov.invitation_info($1)', (a) => [a.tokenHash]),
  'iso.invitation.accept': fnRows('SELECT * FROM gov.identity_accept_legacy($1,$2)', (a) => [a.tokenHash,a.user]),
  'iso.account.bind': fn('SELECT gov.bind_account($1)', (a) => [a.user]),
  'iso.document.create': fn('SELECT gov.create_document($1, $2, $3, $4, $5)', (a) => [
    a.task ?? null,
    a.title ?? 'Plan',
    a.content,
    a.by,
    a.workspace ?? null,
  ]),
  'iso.document.revise': fn('SELECT gov.revise_document($1, NULL, $2)', (a) => [a.document, a.content]),
  /** A session's attempt to mark a run directly: marks come only from what a run read. */
  'iso.run.set_marks': direct(async (c, a) => {
    const { rowCount } = await c.query('UPDATE app.runs SET tainted_untrusted = $2, untrusted_source = $3 WHERE id = $1', [a.run, a.untrusted, a.source]);
    return rowCount;
  }),
  /** The service's attempt to empty the ledger. */
  'iso.ledger.truncate': direct(async (c) => {
    await c.query('TRUNCATE app.ledger');
    return null;
  }),
};

const mandates: Bindings = {
  'man.checker_independent': fn('SELECT sec.checker_independent($1, $2, $3, $4)', (a) => [a.workspace, a.proposer, a.checker, a.strict]),
  'man.connection_register': fn(`SELECT gov.register_connection($1, $2, $3, $4, 'none')`, (a) => [
    a.name,
    a.slug,
    `https://${String(a.slug).replace(/_/g, '-')}.example.com/mcp`,
    a.scope,
  ]),
  'man.claim_next_verification': fnRow(
    'SELECT workspace_id AS workspace, decision_id AS decision, verifier_id AS verifier FROM gov.claim_next_verification($1, $2)',
    (a) => [a.worker ?? 'verifier-worker', a.leaseMs ?? 60_000],
  ),
  'man.set_verifier_allowance': fn('SELECT gov.set_verifier_allowance($1)', (a) => [a.tokens]),
  'man.verifier_allowance': fn('SELECT gov.verifier_allowance()', () => []),
  'man.record_verifier_usage': fn('SELECT gov.record_verifier_usage($1)', (a) => [a.tokens]),
};

const effects: Bindings = {
  /** The whole proposal crossing, with the project and expected version `effect.propose` leaves out. */
  'eff.propose_connected': fn(
    'SELECT gov.propose_effect($1, $2, $3, $4, $5, $6, $7, $8::smallint, $9::boolean, $10::jsonb, $11, $12, $13)',
    (a) => [
      a.run,
      a.fence,
      a.step ?? 1,
      a.tool,
      a.operation,
      a.connection,
      a.project ?? null,
      a.classHint ?? null,
      a.externalHint ?? null,
      json(a.args ?? { deal: 'D-42', stage: 'won' }),
      a.description ?? 'Synthetic connected change',
      a.expectedVersion ?? null,
      a.idempotencyKey ?? `idem-${randomUUID()}`,
    ],
  ),
  /** An effect row written by the service directly, past the gateway. */
  'eff.direct_write': direct(async (c, a, actor) => {
    if (a.op === 'update') return (await c.query(`UPDATE app.effects SET status = 'allowed' WHERE id = $1`, [a.effect])).rowCount;
    if (a.op === 'delete') return (await c.query('DELETE FROM app.effects WHERE id = $1', [a.effect])).rowCount;
    return scalar(
      c,
      `INSERT INTO app.effects (workspace_id, run_id, step_seq, proposer_id, mandate_id, operation, connection, effect_class,
                                external_party, args, args_hash, description, idempotency_key, status)
       VALUES ($1, $2, 99, $3, $4, 'crm:update_deal', 'crm', 1, false, '{}', 'forged', 'Forged', $5, 'allowed') RETURNING id`,
      [ws(actor), a.run, a.proposer, a.mandate, `forged-${randomUUID()}`],
    );
  }),
  'eff.connection.register': fn('SELECT gov.register_connection($1, $2, $3, $4, $5)', (a) => [
    a.name ?? 'Synthetic repeat test',
    a.slug,
    a.url ?? `https://mcp.example.test/${String(a.slug)}`,
    a.scope ?? 'workspace',
    a.auth ?? 'none',
  ]),
  'eff.connection.record_tools': fn("SELECT gov.record_connection_tools($1, 'ok', $2::jsonb, NULL)", (a) => [a.connection, json(a.tools)]),
  'eff.task.share': fn('SELECT gov.share_task($1)', (a) => [a.task]),
  'eff.document.create': fn('SELECT gov.create_document(NULL, $1, $2, NULL)', (a) => [a.title ?? 'Plan', a.content]),
  /** What a dispatcher writes while it dispatches a document effect. */
  'eff.document.write': fn('SELECT gov.write_document_by_effect($1, $2, NULL, $3, false, NULL)', (a) => [a.via, a.document, a.content]),
};

const ledger: Bindings = {
  'led.ledger_rewrite': direct(async (c, _a, actor) => (await c.query(`UPDATE app.ledger SET payload = '{}' WHERE workspace_id = $1`, [ws(actor)])).rowCount),
  'led.ledger_erase': direct(async (c, _a, actor) => (await c.query('DELETE FROM app.ledger WHERE workspace_id = $1', [ws(actor)])).rowCount),
  'led.ledger_forge': direct(async (c, _a, actor) =>
    (
      await c.query(`INSERT INTO app.ledger (workspace_id, seq, entry_type, prev_hash, hash) VALUES ($1, 999, 'forged.entry', 'x', 'y')`, [
        ws(actor),
      ])
    ).rowCount,
  ),
  'led.run_queue_with_state': direct(async (c, a, actor) =>
    scalar(
      c,
      'INSERT INTO app.runs (workspace_id, task_id, agent_id, mandate_id, status, fence) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [ws(actor), a.task, a.agent, a.mandate, a.status ?? 'running', a.fence ?? 7],
    ),
  ),
  'led.run_set_status': direct(async (c, a) => (await c.query('UPDATE app.runs SET status = $2 WHERE id = $1', [a.run, a.status])).rowCount),
  'led.connection_register': fn('SELECT gov.register_connection($1, $2, $3, $4, $5)', (a) => [
    a.name,
    a.slug,
    a.url,
    a.scope ?? 'workspace',
    a.auth ?? 'none',
  ]),
  'led.connection_record_tools': fn('SELECT gov.record_connection_tools($1, $2, $3::jsonb, $4)', (a) => [
    a.connection,
    a.status ?? 'ok',
    json(a.tools),
    a.error ?? null,
  ]),
  'led.connection_mark_sensitive': fn('SELECT gov.mark_connection($1, $2)', (a) => [a.connection, a.sensitive]),
};

const withPrincipal = (actor: { workspace?: string; principal?: string }) =>
  actor.principal === undefined ? { workspace: ws(actor) } : { workspace: ws(actor), principal: actor.principal };

const promotion: Bindings = {
  /** Record a source stating every field: its kind, its trust and which principal records it. */
  'pro.source_record_as': fn('SELECT gov.record_source($1, $2, $3, $4, $5, NULL, $6, $7)', (a, actor) => [
    a.kind ?? 'file',
    a.ref ?? 'drive://x',
    a.content,
    a.authoredBy ?? null,
    a.run ?? null,
    a.trust ?? 'trusted',
    a.principal ?? actor.principal ?? null,
  ]),
  /** The same, from a session that names a principal and also presents a run with its secret. */
  'pro.source_record_as_in_run': composite(async (_c, a, actor, { session }) => {
    const { run, secret, ...rest } = a;
    return session({ ...withPrincipal(actor), run: { id: String(run), secret: String(secret) } }).call('pro.source_record_as', rest);
  }),
  /** A candidate that states its own owner, written straight into the store. */
  'pro.propose_candidate_with_owner': direct(async (c, a, actor) =>
    scalar(
      c,
      `INSERT INTO app.knowledge_candidates (workspace_id, statement, topic, evidence, proposed_by, owner_id)
       VALUES ($1, $2, 'launch', $3::jsonb, $4, $5) RETURNING id`,
      [ws(actor), a.statement, json(a.evidence), a.proposedBy, a.owner],
    ),
  ),
  /** Accepted knowledge written straight into the store, past promotion. */
  'pro.write_accepted_knowledge': direct(async (c, a, actor) =>
    scalar(
      c,
      `INSERT INTO app.knowledge (workspace_id, candidate_id, decision_id, statement, topic, owner_id, accepted_by)
       VALUES ($1, $2, $3, $4, 'launch', $5, $5) RETURNING id`,
      [ws(actor), a.candidate, a.decision, a.statement, a.owner],
    ),
  ),
  /** Accepted knowledge changed in place. */
  'pro.rewrite_knowledge': direct(async (c, a, actor) =>
    (
      await c.query('UPDATE app.knowledge SET statement = coalesce($3, statement), status = coalesce($4, status) WHERE workspace_id = $1 AND id = $2', [
        ws(actor),
        a.knowledge,
        a.statement ?? null,
        a.status ?? null,
      ])
    ).rowCount,
  ),
  /** Request promotion from a session whose clock reads in `timeZone`. */
  'pro.request_promotion_in_zone': composite(async (c, a) => {
    await c.query(`SELECT set_config('TimeZone', $1, true)`, [a.timeZone]);
    return scalar(c, 'SELECT gov.request_promotion($1, $2, $3, $4)', [a.candidate, a.owner, a.validFrom ?? null, a.validTo ?? null]);
  }),
  'pro.change_role': fn('SELECT gov.identity_change_role($1, $2)', (a) => [a.person, a.role]),
  'pro.memory_write': composite(async (c, a) => {
    await c.query('SELECT gov.write_memory($1, $2, $3)', [a.owner, a.agent, a.content]);
    return null;
  }),
  /** Recall from a session that names a principal and also presents a run, with or without its secret. */
  'pro.memory_recall_claiming': composite(async (_c, a, actor, { session }) =>
    session({ ...withPrincipal(actor), run: { id: String(a.run), secret: String(a.secret ?? '') } }).call('memory.recall', {
      run: a.run,
      limit: a.limit,
    }),
  ),
};

/** Every crossing binding, by family. A name bound twice is a mistake, refused at load. */
export const crossings: Bindings = merge({ core, isolation, mandates, effects, ledger, promotion, ruleOfTwo });
