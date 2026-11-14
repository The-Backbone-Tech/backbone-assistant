-- Memory another agent's store held, imported for a person: its words, until the person accepts it.
CREATE TABLE app.memory_proposals (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL,
  source text NOT NULL,
  content text NOT NULL,
  path text,
  line integer,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'declined')),
  memory_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, person_id) REFERENCES app.principals (workspace_id, id)
);
ALTER TABLE app.memory_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.memory_proposals AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.memory_proposals FOR SELECT TO backbone_app USING (NOT sec.names_run() AND person_id = sec.current_principal());
CREATE POLICY crossings ON app.memory_proposals FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.memory_proposals FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER keep BEFORE UPDATE OR DELETE ON app.memory_proposals FOR EACH ROW EXECUTE FUNCTION sec.t_keep_columns('id', 'workspace_id', 'person_id', 'source', 'content', 'created_at');
GRANT SELECT ON app.memory_proposals TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.memory_proposals TO backbone_gov;
