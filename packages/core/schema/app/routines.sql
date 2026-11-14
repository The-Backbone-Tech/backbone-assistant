-- A routine a person set for one of their agents: its own task, its mandate, and (for an instruction routine) the person's instruction.
CREATE TABLE app.routines (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  task_id uuid NOT NULL,
  mandate_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('instruction', 'morning_brief', 'nightly_tidy')),
  title text NOT NULL,
  instruction text,
  schedule text,
  timezone text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, person_id) REFERENCES app.principals (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES app.tasks (workspace_id, id),
  FOREIGN KEY (workspace_id, mandate_id) REFERENCES app.mandates (workspace_id, id)
);
ALTER TABLE app.routines ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.routines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.routines AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.routines FOR SELECT TO backbone_app USING (sec.task_visible(task_id));
CREATE POLICY crossings ON app.routines FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.routines FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER keep BEFORE UPDATE OR DELETE ON app.routines FOR EACH ROW EXECUTE FUNCTION sec.t_keep_columns('id', 'workspace_id', 'person_id', 'agent_id', 'task_id', 'mandate_id', 'kind', 'instruction', 'created_at');
GRANT SELECT ON app.routines TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.routines TO backbone_gov;
