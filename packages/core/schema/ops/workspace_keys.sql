-- Each workspace's digest key for the words its ledger names by digest. Never readable by the service.
CREATE TABLE ops.workspace_keys (
  workspace_id uuid PRIMARY KEY,
  digest_key bytea NOT NULL CHECK (length(digest_key) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
GRANT SELECT, INSERT ON ops.workspace_keys TO backbone_gov;
