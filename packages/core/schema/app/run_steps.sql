-- What a run did, step by step: input frozen when written, output once completed.
CREATE TABLE app.run_steps (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  run_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  kind text NOT NULL,
  title text,
  input jsonb NOT NULL DEFAULT '{}',
  output jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  fence bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, run_id, seq),
  FOREIGN KEY (workspace_id, run_id) REFERENCES app.runs (workspace_id, id)
);
ALTER TABLE app.run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.run_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.run_steps AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.run_steps FOR SELECT TO backbone_app USING (sec.run_visible(run_id));
CREATE POLICY crossings ON app.run_steps FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.run_steps FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER frozen BEFORE UPDATE OR DELETE ON app.run_steps FOR EACH ROW EXECUTE FUNCTION sec.t_step();
GRANT SELECT ON app.run_steps TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.run_steps TO backbone_gov;
