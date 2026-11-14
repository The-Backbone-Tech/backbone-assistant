import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enter } from '../src/db/session.ts';
import { startTestPostgres, type TestPostgres } from '../src/db/testing.ts';

/**
 * Recall hands accepted knowledge to a run, so it hands over only what holds now: knowledge is
 * promoted with a validity window (null bound = open), and outside it a fact is not truth.
 */
let postgres: TestPostgres;
let service: pg.Client;
let ws: string;
let owner: string;
let agent: string;
let run: { id: string; secret: string };

type Actor = Parameters<typeof enter>[1];
const as = async <T>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> => {
  await enter(service, actor);
  try {
    return (await service.query(sql, params)).rows as T[];
  } finally {
    await service.query('COMMIT');
  }
};
const one = async <T>(actor: Actor, sql: string, params: unknown[] = []): Promise<T> => (await as<{ v: T }>(actor, `SELECT (${sql}) AS v`, params))[0]?.v as T;

const hours = (n: number) => new Date(Date.now() + n * 3_600_000);

/** Accept a statement into knowledge under the given window, through the real promotion route. */
async function accept(statement: string, validFrom: Date | null, validTo: Date | null): Promise<void> {
  const system = { workspace: ws, principal: await one<string>({ workspace: ws }, `SELECT id FROM app.principals WHERE kind = 'system'`) };
  const episode = await one<string>(system, `gov.record_source('message', 'workspace://planning', $1, $2, $3, NULL, 'trusted')`, [statement, owner, run.id]);
  const proposer = { workspace: ws, principal: agent, run };
  const candidate = await one<string>(proposer, 'gov.propose_candidate($1, $2::jsonb, $3, $4)', [
    statement,
    JSON.stringify([{ episode, excerpt: statement }]),
    agent,
    'planning',
  ]);
  const decision = await one<string>(proposer, 'gov.request_promotion($1, $2, $3, $4)', [candidate, owner, validFrom, validTo]);
  const person = { workspace: ws, principal: owner };
  const [{ proposal_hash }] = await as<{ proposal_hash: string }>(person, 'SELECT proposal_hash FROM app.decisions WHERE id = $1', [decision]);
  await as(person, 'SELECT gov.answer_decision($1, $2, $3, $4)', [decision, proposal_hash, 'approved', 'checked']);
}

const recalled = async (words: string[] = []) =>
  (await as<{ statement: string }>({ workspace: ws, run }, 'SELECT statement FROM gov.recall_knowledge($1, $2, 100)', [run.id, words])).map((r) => r.statement).sort();

beforeAll(async () => {
  postgres = await startTestPostgres();
  await postgres.clone('recall');
  const operator = new pg.Client({ connectionString: postgres.operatorUrl('recall') });
  await operator.connect();
  const { rows: [made] } = await operator.query('SELECT * FROM operator.create_workspace($1, $2, $3, $4)', ['Recall', 'personal', 'Owner', 'o@example.com']);
  await operator.end();
  ws = made.workspace_id;
  owner = made.owner_id;
  service = new pg.Client({ connectionString: postgres.appUrl('recall') });
  await service.connect();
  const me = { workspace: ws, principal: owner };
  agent = await one<string>(me, `gov.create_agent('Worker', 'worker')`);
  const mandate = await one<string>(me, 'gov.issue_mandate($1, NULL, \'"*"\'::jsonb, \'"*"\'::jsonb, \'"*"\'::jsonb, \'"*"\'::jsonb, 4::smallint, NULL, NULL, NULL, NULL, $2, \'direct\')', [agent, hours(1)]);
  const task = await one<string>(me, `gov.create_task($1, $1, 'Recall', NULL, NULL, 'task', NULL)`, [owner]);
  const queued = await one<string>(me, 'gov.queue_run($1, $2, $3)', [task, agent, mandate]);
  const [claimed] = await as<{ secret: string }>({ workspace: ws }, 'SELECT secret FROM gov.claim_run($1, $2, $3, $4)', [queued, 'worker-1', 60_000, 'direct']);
  run = { id: queued, secret: claimed?.secret as string };
});

afterAll(async () => {
  await service?.end();
  await postgres?.stop();
});

describe('recall honours the validity of knowledge (R-KNOW)', () => {
  it('recalls knowledge with open bounds or a current window, and not what has expired or not begun', async () => {
    await accept('Open bounds: the office is in Lisbon.', null, null);
    await accept('Current window: the discount is 10 percent.', hours(-24), hours(24));
    await accept('Open end: support hours are nine to five.', hours(-24), null);
    await accept('Open start: the pilot ends in spring.', null, hours(24));
    await accept('Expired: the old price was 40 euros.', hours(-48), hours(-1));
    await accept('Not yet valid: the new price is 50 euros.', hours(1), hours(48));
    const all = await recalled();
    expect(all).toEqual([
      'Current window: the discount is 10 percent.',
      'Open bounds: the office is in Lisbon.',
      'Open end: support hours are nine to five.',
      'Open start: the pilot ends in spring.',
    ]);
  });

  it('applies the same validity when recall is narrowed by words', async () => {
    expect(await recalled(['price'])).toEqual([]);
    expect(await recalled(['discount'])).toEqual(['Current window: the discount is 10 percent.']);
  });
});
