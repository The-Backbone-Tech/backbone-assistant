-- A person's private memory. Read by that person, recalled by their runs through the crossing that marks them, forgotten for good.
CREATE TABLE app.memory (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  agent_id uuid,
  content text NOT NULL,
  words_untrusted boolean NOT NULL DEFAULT false,
  run_id uuid,
  step_seq integer,
  forgotten_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, owner_id) REFERENCES app.principals (workspace_id, id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES app.principals (workspace_id, id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES app.runs (workspace_id, id)
);
ALTER TABLE app.memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.memory AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.memory FOR SELECT TO backbone_app USING (NOT sec.names_run() AND owner_id = sec.current_principal());
CREATE POLICY crossings ON app.memory FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.memory FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE UNIQUE INDEX memory_once_per_step ON app.memory (workspace_id, run_id, step_seq, content) WHERE run_id IS NOT NULL AND step_seq IS NOT NULL;
CREATE TRIGGER rules BEFORE UPDATE OR DELETE ON app.memory FOR EACH ROW EXECUTE FUNCTION sec.t_memory();
GRANT SELECT ON app.memory TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.memory TO backbone_gov;
