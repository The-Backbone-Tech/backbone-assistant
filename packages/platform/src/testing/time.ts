// Tests only: let time pass for the dispatch claims in a data home, so a dispatcher that was killed
// is past its claim's lease and the core's 30-second grace window (R-EFF-STALE-01) without waiting
// a minute. It moves the claims' lease into the past as the cluster's administrator; nothing else.
import pg from 'pg';
import { dataHomeAdminUrl } from '@backbone/core/testing';

export async function lapseDispatchClaims(home: string): Promise<void> {
  const admin = new pg.Client({ connectionString: dataHomeAdminUrl(home) });
  await admin.connect();
  try {
    await admin.query(`UPDATE ops.effect_queue SET lease_expires_at = clock_timestamp() - interval '31 seconds' WHERE claim_token IS NOT NULL`);
  } finally {
    await admin.end();
  }
}
