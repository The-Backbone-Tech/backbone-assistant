-- A proposed change to the catalogue. Raising applies at once; lowering, in a team, waits for an independent answer.
CREATE TABLE app.operation_changes (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  changes jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('applied', 'open', 'rejected', 'withdrawn')),
  proposed_by uuid NOT NULL,
  decision_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, proposed_by) REFERENCES app.principals (workspace_id, id)
);
ALTER TABLE app.operation_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.operation_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.operation_changes AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.operation_changes FOR SELECT TO backbone_app USING (true);
CREATE POLICY crossings ON app.operation_changes FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.operation_changes FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER keep BEFORE UPDATE OR DELETE ON app.operation_changes FOR EACH ROW EXECUTE FUNCTION sec.t_keep_columns('id', 'workspace_id', 'changes', 'proposed_by', 'created_at');
GRANT SELECT ON app.operation_changes TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.operation_changes TO backbone_gov;
