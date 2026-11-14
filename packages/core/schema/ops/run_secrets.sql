-- The hash of each run's current claim secret, by fence. Only the crossings read it.
CREATE TABLE ops.run_secrets (
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  fence bigint NOT NULL,
  secret_hash text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, run_id, fence)
);
GRANT SELECT, INSERT ON ops.run_secrets TO backbone_gov;
