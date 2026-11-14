-- A unit of work for a person. Private to its people until shared with the workspace.
CREATE TABLE app.tasks (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL,
  goal text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'done', 'cancelled')),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'workspace')),
  kind text NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'conversation', 'routine', 'import', 'channel')),
  requested_by uuid NOT NULL,
  on_behalf_of uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, requested_by) REFERENCES app.principals (workspace_id, id),
  FOREIGN KEY (workspace_id, on_behalf_of) REFERENCES app.principals (workspace_id, id)
);
ALTER TABLE app.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.tasks AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.tasks FOR SELECT TO backbone_app USING (sec.task_visible(id));
CREATE POLICY crossings ON app.tasks FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.tasks FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER keep BEFORE UPDATE OR DELETE ON app.tasks FOR EACH ROW EXECUTE FUNCTION sec.t_keep_columns('id', 'workspace_id', 'requested_by', 'on_behalf_of', 'kind', 'created_at');
GRANT SELECT ON app.tasks TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.tasks TO backbone_gov;
