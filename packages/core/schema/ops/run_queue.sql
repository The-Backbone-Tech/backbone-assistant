-- The cross-workspace run queue: every run a worker may yet claim, and from when. A queued run is
-- claimable at once, a running one when its lease ends, a parked one only once woken. Each entry
-- carries its run's carrier key (the registered piece, or 'direct'), held to the run's by a foreign
-- key, so a worker selects only the runs of what it runs before it locks anything.
CREATE TABLE ops.run_queue (
  run_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  carrier_key text NOT NULL,
  claimable_after timestamptz,
  enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, run_id, carrier_key) REFERENCES app.runs (workspace_id, id, carrier_key)
);
CREATE INDEX run_queue_due ON ops.run_queue (carrier_key, claimable_after, enqueued_at) WHERE claimable_after IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.run_queue TO backbone_gov;
