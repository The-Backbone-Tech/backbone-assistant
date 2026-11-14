-- The per-workspace hash-chained record of who did what under which authority: identifiers and keyed digests, never words. Append-only.
CREATE TABLE app.ledger (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  seq bigint NOT NULL CHECK (seq > 0),
  entry_type text NOT NULL,
  actor_id uuid,
  subject text,
  payload jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  prev_hash text NOT NULL,
  hash text NOT NULL,
  PRIMARY KEY (workspace_id, seq)
);
ALTER TABLE app.ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.ledger AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.ledger FOR SELECT TO backbone_app USING (true);
CREATE POLICY crossings ON app.ledger FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.ledger FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE INDEX ledger_subject ON app.ledger (workspace_id, subject);
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON app.ledger FOR EACH ROW EXECUTE FUNCTION sec.t_ledger_append_only();
GRANT SELECT ON app.ledger TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.ledger TO backbone_gov;
