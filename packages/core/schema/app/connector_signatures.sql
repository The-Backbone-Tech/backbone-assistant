-- A person's terminal, workspace-scoped signature for one registered connector tool.
CREATE TABLE app.connector_signatures (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  tool_name text NOT NULL,
  operation text NOT NULL,
  definition_digest text NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
  given_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  end_reason text CHECK (end_reason IN ('person_revoked','definition_changed','connection_removed','home_moved','superseded')),
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,person_id) REFERENCES app.principals(workspace_id,id),
  FOREIGN KEY (workspace_id,connection_id,tool_name) REFERENCES app.connection_tools(workspace_id,connection_id,name),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
ALTER TABLE app.connector_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connector_signatures FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.connector_signatures AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY crossings ON app.connector_signatures FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.connector_signatures FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER keep BEFORE UPDATE OR DELETE ON app.connector_signatures FOR EACH ROW
  EXECUTE FUNCTION sec.t_keep_columns('workspace_id','id','person_id','connection_id','tool_name','operation','definition_digest','given_at');
GRANT SELECT,INSERT,UPDATE ON app.connector_signatures TO backbone_gov;
CREATE UNIQUE INDEX connector_signatures_live ON app.connector_signatures(workspace_id,person_id,connection_id,tool_name) WHERE ended_at IS NULL;
CREATE TRIGGER terminal BEFORE UPDATE ON app.connector_signatures FOR EACH ROW
  EXECUTE FUNCTION sec.t_connector_signature_terminal();
ALTER TABLE app.connector_signatures ENABLE ALWAYS TRIGGER terminal;
