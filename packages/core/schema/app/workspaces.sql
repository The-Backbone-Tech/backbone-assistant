-- A workspace: the tenant every other row belongs to.
CREATE TABLE app.workspaces (
id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('personal', 'team', 'company')),
  delay_window_ms integer NOT NULL DEFAULT 0 CHECK (delay_window_ms >= 0),
  verifier_allowance bigint NOT NULL DEFAULT 2000000 CHECK (verifier_allowance >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE app.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.workspaces AS RESTRICTIVE FOR ALL TO PUBLIC USING (id = (SELECT sec.current_workspace())) WITH CHECK (id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.workspaces FOR SELECT TO backbone_app USING (true);
CREATE POLICY crossings ON app.workspaces FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.workspaces FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER keep BEFORE UPDATE OR DELETE ON app.workspaces FOR EACH ROW EXECUTE FUNCTION sec.t_keep_columns('id', 'kind', 'created_at');
GRANT SELECT ON app.workspaces TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.workspaces TO backbone_gov;
