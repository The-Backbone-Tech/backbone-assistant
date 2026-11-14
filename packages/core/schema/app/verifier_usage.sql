-- What verifiers spent, per workspace and day, against the allowance owners and admins set.
CREATE TABLE app.verifier_usage (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  day date NOT NULL,
  tokens bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  PRIMARY KEY (workspace_id, day)
);
ALTER TABLE app.verifier_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.verifier_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.verifier_usage AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.verifier_usage FOR SELECT TO backbone_app USING (true);
CREATE POLICY crossings ON app.verifier_usage FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.verifier_usage FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER keep BEFORE UPDATE OR DELETE ON app.verifier_usage FOR EACH ROW EXECUTE FUNCTION sec.t_keep_columns('workspace_id', 'day');
GRANT SELECT ON app.verifier_usage TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.verifier_usage TO backbone_gov;
