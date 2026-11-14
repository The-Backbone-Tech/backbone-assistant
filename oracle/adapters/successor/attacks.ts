import { randomUUID } from 'node:crypto';
import { reasonOf } from '../../../packages/core/src/db/session.ts';
import type { Reason } from '../../target.ts';
import { type Client, merge } from './binding.ts';
import { ruleOfTwoAttacks } from './rule-of-two.ts';
import { inventory } from './views.ts';

export type Attack = (admin: Client, args: Record<string, unknown>) => Promise<unknown>;

export interface Attempt {
  refused: boolean;
  reason: Reason | null;
  detail: string | null;
}

const outcome = (error: unknown): Attempt => {
  const e = error as { code?: string; message?: string };
  return { refused: true, reason: reasonOf(e), detail: e.message ?? String(error) };
};

const setWorkspace = (c: Client, workspace: string) => c.query(`SELECT set_config('backbone.workspace', $1, true)`, [workspace]);

/**
 * Run `statements` as the installer (a superuser: past every grant and every row-level policy)
 * with the workspace set, then roll back. What comes back is whether the storage itself refused.
 */
export async function asSuperuser(admin: Client, workspace: string | null, statements: [string, unknown[]][]): Promise<Attempt> {
  await admin.query('BEGIN');
  try {
    if (workspace) await setWorkspace(admin, workspace);
    for (const [sql, params] of statements) await admin.query(sql, params);
    await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
    return { refused: false, reason: null, detail: null };
  } catch (error) {
    return outcome(error);
  } finally {
    await admin.query('ROLLBACK');
  }
}

/**
 * Tamper with the ledger as a superuser who disables its append-only trigger, then run `check` as
 * the service inside the same transaction, and roll everything back.
 */
async function tamperThenCheck(admin: Client, workspace: string, statements: string[], check: string, params: unknown[]) {
  await admin.query('BEGIN');
  try {
    await setWorkspace(admin, workspace);
    await admin.query('ALTER TABLE app.ledger DISABLE TRIGGER append_only');
    for (const s of statements) await admin.query(s, [workspace]);
    await admin.query('ALTER TABLE app.ledger ENABLE TRIGGER append_only');
    await admin.query('SET LOCAL ROLE backbone_app');
    const { rows } = await admin.query(check, params);
    return rows[0];
  } finally {
    await admin.query('ROLLBACK');
  }
}

const w = (a: Record<string, unknown>) => String(a.workspace);

const ledger: Record<string, Attack> = {
  'ledger.rewrite_payload': (c, a) =>
    tamperThenCheck(c, w(a), [`UPDATE app.ledger SET payload = jsonb_set(payload, '{kind}', '"personal"') WHERE workspace_id = $1 AND seq = 1`], 'SELECT gov.verify_ledger() AS bad', []),
  'ledger.rewrite_actor': (c, a) =>
    tamperThenCheck(c, w(a), ['UPDATE app.ledger SET actor_id = gen_random_uuid() WHERE workspace_id = $1 AND seq = 1'], 'SELECT gov.verify_ledger() AS bad', []),
  /** Rewrite the first entry and recompute its own hash as the chain's formula states it. */
  'ledger.rewrite_and_rehash': (c, a) =>
    tamperThenCheck(
      c,
      w(a),
      [
        `UPDATE app.ledger SET payload = jsonb_set(payload, '{kind}', '"personal"'),
                hash = sec.ledger_hash(prev_hash, workspace_id, seq, entry_type, actor_id, subject, jsonb_set(payload, '{kind}', '"personal"'), at)
         WHERE workspace_id = $1 AND seq = 1`,
      ],
      'SELECT gov.verify_ledger() AS bad',
      [],
    ),
  'ledger.truncate_tail': (c, a) =>
    tamperThenCheck(
      c,
      w(a),
      [
        'DELETE FROM app.ledger WHERE workspace_id = $1 AND seq = (SELECT max(seq) FROM app.ledger WHERE workspace_id = $1)',
        `UPDATE app.ledger_heads h SET last_seq = l.seq, last_hash = l.hash FROM app.ledger l
         WHERE h.workspace_id = $1 AND l.workspace_id = $1 AND l.seq = (SELECT max(seq) FROM app.ledger WHERE workspace_id = $1)`,
      ],
      'SELECT gov.verify_ledger() AS internal, gov.verify_ledger_anchor($1, $2) AS anchored',
      [a.seq, a.hash],
    ),
};

const isolation: Record<string, Attack> = {
  'storage.rewrite_source': (c, a) => asSuperuser(c, w(a), [[`UPDATE app.episodes SET content = 'Budget rejected' WHERE id = $1`, [a.source]]]),
  'storage.delete_source': (c, a) => asSuperuser(c, w(a), [['DELETE FROM app.episodes WHERE id = $1', [a.source]]]),
  'storage.rewrite_messages': (c, a) => asSuperuser(c, w(a), [[`UPDATE app.messages SET content = 'Bye' WHERE workspace_id = $1`, [a.workspace]]]),
  'storage.delete_messages': (c, a) => asSuperuser(c, w(a), [['DELETE FROM app.messages WHERE workspace_id = $1', [a.workspace]]]),
  'storage.rewrite_document_versions': (c, a) =>
    asSuperuser(c, w(a), [[`UPDATE app.document_versions SET content = 'forged' WHERE document_id = $1`, [a.document]]]),
  'storage.delete_document_versions': (c, a) => asSuperuser(c, w(a), [['DELETE FROM app.document_versions WHERE document_id = $1', [a.document]]]),
  'storage.delete_ledger': (c, a) => asSuperuser(c, w(a), [['DELETE FROM app.ledger WHERE workspace_id = $1', [a.workspace]]]),
  'storage.rewrite_ledger': (c, a) => asSuperuser(c, w(a), [[`UPDATE app.ledger SET payload = '{}' WHERE workspace_id = $1`, [a.workspace]]]),
  'storage.rewrite_step_input': (c, a) =>
    asSuperuser(c, w(a), [[`UPDATE app.run_steps SET input = '{"q":2}' WHERE run_id = $1 AND seq = $2`, [a.run, a.seq]]]),
  'storage.rewrite_completed_step': (c, a) =>
    asSuperuser(c, w(a), [[`UPDATE app.run_steps SET output = '{"ok":false}' WHERE run_id = $1 AND seq = $2`, [a.run, a.seq]]]),
  'storage.alter_effect_args': (c, a) =>
    asSuperuser(c, w(a), [
      [`UPDATE app.effects SET args = '{"field":"stage","value":"lost"}' WHERE id = $1`, [a.effect]],
    ]),
  'storage.skip_effect_status': (c, a) => asSuperuser(c, w(a), [[`UPDATE app.effects SET status = $2 WHERE id = $1`, [a.effect, a.to]]]),
  'storage.insert_effect_with_wrong_hash': (c, a) =>
    asSuperuser(c, w(a), [
      [
        `INSERT INTO app.effects (workspace_id, run_id, step_seq, proposer_id, mandate_id, operation, effect_class,
                                  args, args_hash, description, idempotency_key)
         VALUES ($1, $2, 1, $3, $4, 'crm:update_deal', 3, '{"a":1}', 'not-the-hash-of-the-args', 'x', 'idem-forged-1')`,
        [a.workspace, a.run, a.agent, a.mandate],
      ],
    ]),
  'storage.answer_as': (c, a) =>
    asSuperuser(c, w(a), [[`UPDATE app.decisions SET status = 'approved', answered_by = $2, answered_at = now() WHERE id = $1`, [a.decision, a.by]]]),
  'storage.reopen_decision': (c, a) => asSuperuser(c, w(a), [[`UPDATE app.decisions SET status = 'open', answered_at = NULL WHERE id = $1`, [a.decision]]]),
  'storage.alter_mandate': (c, a) => asSuperuser(c, w(a), [['UPDATE app.mandates SET ceiling = 1 WHERE id = $1', [a.mandate]]]),
  'storage.unrevoke_mandate': (c, a) => asSuperuser(c, w(a), [['UPDATE app.mandates SET revoked_at = NULL WHERE id = $1', [a.mandate]]]),
  'storage.rewrite_candidate': (c, a) =>
    asSuperuser(c, w(a), [[`UPDATE app.knowledge_candidates SET statement = 'The office moves in June.' WHERE id = $1`, [a.candidate]]]),
  'storage.flip_candidate_marks': (c, a) =>
    asSuperuser(c, w(a), [['UPDATE app.knowledge_candidates SET words_untrusted = NOT words_untrusted WHERE id = $1', [a.candidate]]]),
  'storage.reassign_candidate': (c, a) => asSuperuser(c, w(a), [['UPDATE app.knowledge_candidates SET owner_id = $2 WHERE id = $1', [a.candidate, a.to]]]),
  'storage.reopen_closed_candidate': (c, a) =>
    asSuperuser(c, w(a), [
      [`UPDATE app.knowledge_candidates SET status = 'withdrawn' WHERE id = $1`, [a.candidate]],
      [`UPDATE app.knowledge_candidates SET status = 'open' WHERE id = $1`, [a.candidate]],
    ]),
  'storage.reassign_memory': (c, a) => asSuperuser(c, w(a), [['UPDATE app.memory SET owner_id = $2 WHERE id = $1', [a.memory, a.to]]]),
  'storage.unforget_memory': (c, a) =>
    asSuperuser(c, w(a), [[`UPDATE app.memory SET content = $2, forgotten_at = NULL WHERE id = $1`, [a.memory, a.content]]]),
  'storage.rebind_account': (c, a) => asSuperuser(c, w(a), [[`UPDATE app.principals SET user_id = 'someone-else' WHERE id = $1`, [a.principal]]]),
  'storage.retarget_document': (c, a) => asSuperuser(c, w(a), [['UPDATE app.documents SET task_id = $2 WHERE id = $1', [a.document, a.task]]]),
  /** A superuser rewrites a document and claims an old version number; returns what the store kept. */
  'storage.rewrite_document': async (c, a) => {
    await c.query('BEGIN');
    try {
      await setWorkspace(c, w(a));
      await c.query(`UPDATE app.documents SET content = 'rewritten', version = 1 WHERE id = $1`, [a.document]);
      const { rows } = await c.query(
        `SELECT d.version, d.content, v.version AS kept_version, v.content AS kept
         FROM app.documents d JOIN app.document_versions v ON v.workspace_id = d.workspace_id AND v.document_id = d.id
         WHERE d.id = $1`,
        [a.document],
      );
      return rows;
    } finally {
      await c.query('ROLLBACK');
    }
  },
  'storage.truncate_ledger_as_owner': async (c) => {
    const one = async (sql: string) => {
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL ROLE backbone_owner');
        await c.query(sql);
        return { refused: false, reason: null, detail: null };
      } catch (error) {
        return outcome(error);
      } finally {
        await c.query('ROLLBACK');
      }
    };
    return { plain: await one('TRUNCATE app.ledger'), cascade: await one('TRUNCATE app.ledger CASCADE') };
  },
  'storage.truncate_every_store_as_owner': async (c) => {
    await c.query('BEGIN');
    try {
      const stores = (await inventory(c)).map((s) => s.store);
      await c.query('SET LOCAL ROLE backbone_owner');
      const out: Record<string, Attempt> = {};
      for (const store of stores) {
        await c.query('SAVEPOINT attempt');
        out[store] = await c.query(`TRUNCATE app.${store} CASCADE`).then((): Attempt => ({ refused: false, reason: null, detail: null }), outcome);
        await c.query('ROLLBACK TO SAVEPOINT attempt');
      }
      return out;
    } finally {
      await c.query('ROLLBACK');
    }
  },
  /** Roles create functions later, as a later migration would; returns which of them PUBLIC may execute. */
  'storage.later_functions': async (c) => {
    await c.query('BEGIN');
    try {
      const create = async (role: string | null, fn: string) => {
        if (role) await c.query(`SET LOCAL ROLE ${role}`);
        await c.query(`CREATE FUNCTION ${fn}() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
        await c.query('RESET ROLE');
      };
      await create('backbone_owner', 'sec.later_by_owner');
      await create('backbone_gov', 'gov.later_by_gov');
      await create(null, 'sec.later_by_installer');
      await c.query('CREATE ROLE probe_without_defaults NOLOGIN');
      await c.query('GRANT USAGE, CREATE ON SCHEMA sec TO probe_without_defaults');
      await create('probe_without_defaults', 'sec.later_by_probe');
      const { rows } = await c.query<{ fn: string; public: boolean }>(
        `SELECT f AS fn, has_function_privilege('public', f || '()', 'EXECUTE') AS public
         FROM unnest(ARRAY['sec.later_by_owner', 'gov.later_by_gov', 'sec.later_by_installer', 'sec.later_by_probe']) f`,
      );
      return Object.fromEntries(rows.map((r) => [r.fn, r.public]));
    } finally {
      await c.query('ROLLBACK');
    }
  },
  'storage.break_walls_then_inventory': async (c) => {
    await c.query('BEGIN');
    try {
      await c.query('CREATE TABLE app.later_partitioned (workspace_id uuid NOT NULL) PARTITION BY HASH (workspace_id)');
      await c.query('ALTER POLICY tenant_wall ON app.tasks USING (true) WITH CHECK (true)');
      return await inventory(c);
    } finally {
      await c.query('ROLLBACK');
    }
  },
  'storage.drop_wall_then_count': async (c, a) => {
    await c.query('BEGIN');
    try {
      await c.query('DROP POLICY tenant_wall ON app.principals');
      await c.query('SET LOCAL ROLE backbone_app');
      await setWorkspace(c, String(a.from));
      const { rows } = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM app.principals WHERE workspace_id = $1', [a.of]);
      return rows[0]?.n;
    } finally {
      await c.query('ROLLBACK');
    }
  },
  'storage.lower_run_mark': (c, a) =>
    asSuperuser(c, w(a), [['UPDATE app.runs SET tainted_untrusted = false, untrusted_source = NULL WHERE id = $1', [a.run]]]),
  'storage.rewrite_run_mark_source': (c, a) => asSuperuser(c, w(a), [[`UPDATE app.runs SET untrusted_source = 'nothing' WHERE id = $1`, [a.run]]]),
};

// This core records what carries a mandate's work; a writer below every grant states the direct kind.
const MANDATE_INSERT = `INSERT INTO app.mandates (workspace_id, issuer_id, subject_id, on_behalf_of_id, parent_id,
    projects, connections, tools, operations, ceiling, max_tokens, max_cost_micros, max_duration_ms, max_effects, expires_at, carrier)
  VALUES ($1, $2, $3, $2, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'direct') RETURNING id`;

interface Terms {
  projects: unknown;
  connections: unknown;
  tools: unknown;
  operations: unknown;
  ceiling: number;
  budget: { maxTokens: number | null; maxCostMicros: number | null; maxDurationMs: number | null; maxEffects: number | null };
  expiresAt: number;
}
const termsRow = (t: Terms) => [
  JSON.stringify(t.projects),
  JSON.stringify(t.connections),
  JSON.stringify(t.tools),
  JSON.stringify(t.operations),
  t.ceiling,
  t.budget.maxTokens,
  t.budget.maxCostMicros,
  t.budget.maxDurationMs,
  t.budget.maxEffects,
  new Date(t.expiresAt * 1000),
];

const mandates: Record<string, Attack> = {
  'storage.store_child_mandate': async (c, a) => {
    await c.query('BEGIN');
    try {
      await setWorkspace(c, w(a));
      const { rows } = await c.query<{ id: string }>(MANDATE_INSERT, [a.workspace, a.issuer, a.subject, null, ...termsRow(a.parent as Terms)]);
      await c.query('SAVEPOINT child');
      try {
        await c.query(MANDATE_INSERT, [a.workspace, a.issuer, a.subject, rows[0]?.id, ...termsRow(a.child as Terms)]);
        return { accepted: true, reason: null };
      } catch (error) {
        await c.query('ROLLBACK TO SAVEPOINT child');
        return { accepted: false, reason: reasonOf(error as Error) };
      }
    } finally {
      await c.query('ROLLBACK');
    }
  },
  'storage.colleague_in_tree_then_answer': async (c, a) => {
    await c.query('BEGIN');
    try {
      await setWorkspace(c, w(a));
      const independence = async () =>
        (
          await c.query<{ strict: boolean; lenient: boolean }>(
            'SELECT sec.checker_independent($1, $2, $3, true) AS strict, sec.checker_independent($1, $2, $3, false) AS lenient',
            [a.workspace, a.proposer, a.colleague],
          )
        ).rows[0];
      const before = await independence();
      await c.query(
        `INSERT INTO app.mandates (workspace_id, issuer_id, subject_id, on_behalf_of_id, parent_id, ceiling, expires_at, carrier)
         VALUES ($1, $2, $3, $4, $5, 1, now() + interval '1 minute', 'direct')`,
        [a.workspace, a.colleague, a.subject, a.onBehalfOf, a.parent],
      );
      const after = await independence();
      const answered = await c
        .query(`UPDATE app.decisions SET status = 'approved', answered_by = $2, answered_at = now() WHERE id = $1`, [a.decision, a.colleague])
        .then(
          () => 'answered',
          (error: Error) => reasonOf(error),
        );
      return { before, after, answered };
    } finally {
      await c.query('ROLLBACK');
    }
  },
};

/** What one attempt came back with: the SQLSTATE that refused it, its message, or null when it went through. */
interface Refused {
  code: string | null;
  message: string | null;
}

async function attempts(admin: Client, workspace: string, steps: Record<string, (c: Client) => Promise<unknown>>) {
  const result: Record<string, Refused> = {};
  await admin.query('BEGIN');
  try {
    await setWorkspace(admin, workspace);
    for (const [name, step] of Object.entries(steps)) {
      await admin.query('SAVEPOINT attempt');
      try {
        await step(admin);
        await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
        result[name] = { code: null, message: null };
      } catch (error) {
        const e = error as { code?: string; message?: string };
        result[name] = { code: e.code ?? 'error', message: e.message ?? String(error) };
      }
      await admin.query('ROLLBACK TO SAVEPOINT attempt');
      await admin.query('SET CONSTRAINTS ALL DEFERRED');
      await setWorkspace(admin, workspace);
    }
    return result;
  } finally {
    await admin.query('ROLLBACK');
  }
}

interface Probe {
  id?: string;
  workspace: string;
  run: string;
  agent: string;
  mandate: string;
  slug: string;
  step: number;
  repeatOf: string | null;
  args?: Record<string, unknown>;
  route?: string | null;
}

/** A denied lineage row of the same exact change, written below every grant, with its run's task and person. */
function insertDenied(c: Client, p: Probe) {
  return c.query(
    `INSERT INTO app.effects (id, workspace_id, run_id, task_id, step_seq, proposer_id, on_behalf_of_id, mandate_id, tool, operation,
       connection, effect_class, external_party, args, args_hash, description, idempotency_key, status, route, route_reason, repeat_of)
     SELECT $1, $2, r.id, r.task_id, $4, $5, m.on_behalf_of_id, $6, $7, $8, $9, 3, true, $10::jsonb, sec.args_hash($10::jsonb),
            'Forged lineage', $11, 'denied', $12, 'repeat_unknown_blocked', $13
     FROM app.runs r JOIN app.mandates m ON m.workspace_id = r.workspace_id AND m.id = $6
     WHERE r.workspace_id = $2 AND r.id = $3`,
    [
      p.id ?? randomUUID(),
      p.workspace,
      p.run,
      p.step,
      p.agent,
      p.mandate,
      `${p.slug}__update_deal`,
      `mcp.${p.slug}.update_deal`,
      p.slug,
      JSON.stringify(p.args ?? { deal: 'D-42', stage: 'won' }),
      `forged-${randomUUID()}`,
      p.route === undefined ? 'denied' : p.route,
      p.repeatOf,
    ],
  );
}

const effects: Record<string, Attack> = {
  'eff.rewrite_lineage': (admin, a) => {
    const base = { workspace: w(a), run: String(a.run), agent: String(a.agent), mandate: String(a.mandate), slug: String(a.slug) };
    return attempts(admin, base.workspace, {
      unlinkCopy: (c) => c.query('UPDATE app.effects SET repeat_of = NULL WHERE id = $1', [a.blocked]),
      deleteOriginal: (c) => c.query('DELETE FROM app.effects WHERE id = $1', [a.original]),
      rekeyOriginal: (c) => c.query('UPDATE app.effects SET id = $2 WHERE id = $1', [a.original, randomUUID()]),
      moveOriginal: (c) => c.query('UPDATE app.effects SET workspace_id = $2 WHERE id = $1', [a.original, randomUUID()]),
      truncate: async (c) => {
        await c.query('SET LOCAL ROLE backbone_owner');
        await c.query('TRUNCATE app.effects');
      },
      truncateCascade: async (c) => {
        await c.query('SET LOCAL ROLE backbone_owner');
        await c.query('TRUNCATE app.effects CASCADE');
      },
      mismatchedCopy: (c) => insertDenied(c, { ...base, step: 99, repeatOf: String(a.original), args: { deal: 'D-42', stage: 'lost' } }),
      selfCopy: (c) => {
        const id = randomUUID();
        return insertDenied(c, { ...base, id, step: 101, repeatOf: id });
      },
    });
  },
  'eff.forge_lineage': (admin, a) => {
    const base = { workspace: w(a), run: String(a.run), agent: String(a.agent), mandate: String(a.mandate), slug: String(a.slug) };
    const f = a.foreign as Record<string, string>;
    const foreign = { workspace: f.workspace ?? '', run: f.run ?? '', agent: f.agent ?? '', mandate: f.mandate ?? '', slug: f.slug ?? '' };
    return attempts(admin, base.workspace, {
      missingOriginal: (c) => insertDenied(c, { ...base, step: 201, repeatOf: randomUUID() }),
      crossWorkspace: async (c) => {
        const parent = randomUUID();
        await setWorkspace(c, foreign.workspace);
        await insertDenied(c, { ...foreign, id: parent, step: 100, repeatOf: null });
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
        await c.query('SET CONSTRAINTS ALL DEFERRED');
        await setWorkspace(c, base.workspace);
        await insertDenied(c, { ...base, step: 202, repeatOf: parent });
      },
      twoNodeCycle: async (c) => {
        const one = randomUUID();
        const two = randomUUID();
        await insertDenied(c, { ...base, id: one, step: 203, repeatOf: two });
        await insertDenied(c, { ...base, id: two, step: 204, repeatOf: one });
      },
      nullRoute: async (c) => {
        const parent = randomUUID();
        await insertDenied(c, { ...base, id: parent, step: 206, repeatOf: null });
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
        await c.query('SET CONSTRAINTS ALL DEFERRED');
        await insertDenied(c, { ...base, step: 205, repeatOf: parent, route: null });
      },
      wellFormedRoot: (c) => insertDenied(c, { ...base, step: 207, repeatOf: null }),
    });
  },
};

export const attacks: Record<string, Attack> = merge({ ledger, isolation, mandates, effects, ruleOfTwo: ruleOfTwoAttacks });
