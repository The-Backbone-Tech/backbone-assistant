-- Each workspace's last ledger entry: where the next one chains from.
CREATE TABLE app.ledger_heads (
workspace_id uuid PRIMARY KEY REFERENCES app.workspaces (id),
  last_seq bigint NOT NULL DEFAULT 0,
  last_hash text NOT NULL DEFAULT ''
);
ALTER TABLE app.ledger_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ledger_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.ledger_heads AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY crossings ON app.ledger_heads FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.ledger_heads FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER keep BEFORE DELETE ON app.ledger_heads FOR EACH ROW EXECUTE FUNCTION sec.t_keep_columns();
-- The service never reads this store directly: only crossings do.
GRANT SELECT, INSERT, UPDATE ON app.ledger_heads TO backbone_gov;
