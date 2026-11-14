-- A promise a run recorded: to whom, by when. Quoting it quotes the work that made it.
CREATE TABLE app.commitments (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  run_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  to_person uuid,
  text text NOT NULL,
  due date,
  priority smallint NOT NULL DEFAULT 3,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES app.tasks (workspace_id, id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES app.runs (workspace_id, id)
);
ALTER TABLE app.commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.commitments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.commitments AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.commitments FOR SELECT TO backbone_app USING (sec.task_visible(task_id) OR to_person = sec.viewer());
CREATE POLICY crossings ON app.commitments FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.commitments FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER keep BEFORE UPDATE OR DELETE ON app.commitments FOR EACH ROW EXECUTE FUNCTION sec.t_keep_columns('id', 'workspace_id', 'task_id', 'run_id', 'agent_id', 'to_person', 'text', 'due', 'created_at');
GRANT SELECT ON app.commitments TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.commitments TO backbone_gov;
