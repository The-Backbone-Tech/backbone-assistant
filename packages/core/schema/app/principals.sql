-- People, agents and the system principal. Each belongs to exactly one workspace; an account is bound once.
CREATE TABLE app.principals (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('person', 'agent', 'system')),
  role text CHECK (role IN ('owner', 'admin', 'member', 'guest')),
  agent_role text CHECK (agent_role IN ('worker', 'verifier')),
  owner_id uuid,
  name text NOT NULL,
  email text,
  user_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (id),
  FOREIGN KEY (workspace_id, owner_id) REFERENCES app.principals (workspace_id, id),
  CHECK ((kind = 'person') = (role IS NOT NULL)),
  CHECK ((kind = 'agent') = (agent_role IS NOT NULL AND owner_id IS NOT NULL))
);
ALTER TABLE app.principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.principals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.principals AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.principals FOR SELECT TO backbone_app USING (true);
CREATE POLICY crossings ON app.principals FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.principals FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE UNIQUE INDEX principals_one_system ON app.principals (workspace_id) WHERE kind = 'system';
CREATE TRIGGER keep BEFORE UPDATE OR DELETE ON app.principals FOR EACH ROW EXECUTE FUNCTION sec.t_principal();
GRANT SELECT ON app.principals TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.principals TO backbone_gov;
