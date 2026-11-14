-- The workspace's catalogue of operation classes. Built-in classes are fixed and never read from here.
CREATE TABLE app.operations (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  operation text NOT NULL CHECK (length(operation) BETWEEN 1 AND 300),
  effect_class smallint NOT NULL CHECK (effect_class BETWEEN 1 AND 6),
  external boolean NOT NULL,
  undo_operation text,
  description text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, operation)
);
ALTER TABLE app.operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.operations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.operations AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.operations FOR SELECT TO backbone_app USING (true);
CREATE POLICY crossings ON app.operations FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.operations FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER keep BEFORE UPDATE OR DELETE ON app.operations FOR EACH ROW EXECUTE FUNCTION sec.t_keep_columns('workspace_id', 'operation');
GRANT SELECT ON app.operations TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.operations TO backbone_gov;
