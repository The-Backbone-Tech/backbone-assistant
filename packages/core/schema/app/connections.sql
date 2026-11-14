-- A connected server (MCP). A person's own connection is named, in shared places, by its id alone.
CREATE TABLE app.connections (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9_]{0,62}$'),
  url text,
  scope text NOT NULL CHECK (scope IN ('workspace', 'person')),
  owner_id uuid,
  auth text NOT NULL DEFAULT 'none',
  profile text,
  account text,
  scopes text,
  sensitive boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'registered',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, slug),
  FOREIGN KEY (workspace_id, owner_id) REFERENCES app.principals (workspace_id, id),
  CHECK ((scope = 'person') = (owner_id IS NOT NULL))
);
ALTER TABLE app.connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.connections AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.connections FOR SELECT TO backbone_app USING (scope = 'workspace' OR owner_id = sec.viewer() OR sec.viewer() = sec.system_principal());
CREATE POLICY crossings ON app.connections FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.connections FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER keep BEFORE UPDATE OR DELETE ON app.connections FOR EACH ROW EXECUTE FUNCTION sec.t_keep_columns('id', 'workspace_id', 'slug', 'scope', 'owner_id', 'created_at');
GRANT SELECT ON app.connections TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.connections TO backbone_gov;
