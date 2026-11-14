-- What people and agents said in a task's conversation. Evidence: never changed. A kept answer is for one person only.
CREATE TABLE app.messages (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  run_id uuid,
  role text NOT NULL CHECK (role IN ('person', 'agent', 'system')),
  author_id uuid,
  content text NOT NULL,
  only_for uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES app.tasks (workspace_id, id),
  FOREIGN KEY (workspace_id, author_id) REFERENCES app.principals (workspace_id, id)
);
ALTER TABLE app.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.messages AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.messages FOR SELECT TO backbone_app USING (sec.task_visible(task_id) AND (only_for IS NULL OR only_for = sec.viewer()));
CREATE POLICY crossings ON app.messages FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.messages FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE INDEX messages_task ON app.messages (workspace_id, task_id, created_at);
CREATE TRIGGER evidence BEFORE UPDATE OR DELETE ON app.messages FOR EACH ROW EXECUTE FUNCTION sec.t_evidence();
GRANT SELECT ON app.messages TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.messages TO backbone_gov;
