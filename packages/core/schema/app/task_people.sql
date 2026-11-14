-- People a private task is shared with beyond its requester and beneficiary.
CREATE TABLE app.task_people (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  task_id uuid NOT NULL,
  person_id uuid NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, task_id, person_id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES app.tasks (workspace_id, id),
  FOREIGN KEY (workspace_id, person_id) REFERENCES app.principals (workspace_id, id)
);
ALTER TABLE app.task_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.task_people FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.task_people AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.task_people FOR SELECT TO backbone_app USING (sec.task_visible(task_id));
CREATE POLICY crossings ON app.task_people FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.task_people FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER keep BEFORE UPDATE OR DELETE ON app.task_people FOR EACH ROW EXECUTE FUNCTION sec.t_keep_columns('workspace_id', 'task_id', 'person_id', 'joined_at');
GRANT SELECT ON app.task_people TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.task_people TO backbone_gov;
