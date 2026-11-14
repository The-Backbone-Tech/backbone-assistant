-- The cross-workspace dispatch queue and its claims: an allowed effect from when it is due, a
-- claimed one until its lease ends, a dispatching one until its lease and the grace window end.
CREATE TABLE ops.effect_queue (
  effect_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  claim_token text,
  lease_expires_at timestamptz,
  stale_handed_until timestamptz,
  enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX effect_queue_due ON ops.effect_queue (due_at, enqueued_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.effect_queue TO backbone_gov;
