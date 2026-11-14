// One v0.8 host in its own process, sent one turn, for the real kills in sql-v08-host-sql.ts.
import pg from 'pg';
import { createV08Host } from '../src/authority/sql-v08/host.ts';
import { identityMint, presentPersonSessions } from '../src/authority/sql-v08/session-owner.ts';
import { scriptedPresence } from './sql-v08-cluster.ts';

const { home, appUrl, observerUrl, identityUrl, binding, projectId, leaseMs } = JSON.parse(process.argv[2]) as Record<string, never>;
const host = await createV08Host({ home, appPool: new pg.Pool({ connectionString: appUrl }), observerPool: new pg.Pool({ connectionString: observerUrl }), sessions: presentPersonSessions({ binding, mint: identityMint(new pg.Pool({ connectionString: identityUrl }), binding), presence: scriptedPresence() }),
  binding, dispatchLeaseMs: leaseMs, writeDelayMs: Number(process.env.BACKBONE_V08_WRITE_DELAY_MS ?? 0) });
const sent = await host.call('turns.send', { projectId, text: 'Write a brief from this.', attachments: [],
  settings: { permission: 'full', model: 'stub', effort: 4, runsOn: 'this-computer', mode: 'chat' }, clientKey: 'killed' });
if (!sent.ok) throw new Error(sent.detail);
setTimeout(() => { console.error('The fixture did not reach its crash cut.'); process.exit(1); }, Number(process.env.BACKBONE_V08_WRITE_DELAY_MS ?? 0) + 15_000);
