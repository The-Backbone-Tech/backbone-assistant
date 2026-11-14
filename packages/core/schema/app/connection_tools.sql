-- The tools a connected server lists, as last discovered.
CREATE TABLE app.connection_tools (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  connection_id uuid NOT NULL,
  name text NOT NULL,
  title text,
  input_schema jsonb,
  discovered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  removed_at timestamptz,
  PRIMARY KEY (workspace_id, connection_id, name),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES app.connections (workspace_id, id)
);
ALTER TABLE app.connection_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_tools FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.connection_tools AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.connection_tools FOR SELECT TO backbone_app USING (EXISTS (SELECT FROM app.connections c WHERE c.workspace_id = connection_tools.workspace_id AND c.id = connection_tools.connection_id));
CREATE POLICY crossings ON app.connection_tools FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.connection_tools FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER keep BEFORE UPDATE OR DELETE ON app.connection_tools FOR EACH ROW EXECUTE FUNCTION sec.t_keep_columns('workspace_id', 'connection_id', 'name');
GRANT SELECT ON app.connection_tools TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.connection_tools TO backbone_gov;
