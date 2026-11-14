-- A channel workspace (a Slack team) the workspace is connected to.
CREATE TABLE app.channel_accounts (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  platform text NOT NULL,
  team text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, platform, team)
);
ALTER TABLE app.channel_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.channel_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.channel_accounts AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.channel_accounts FOR SELECT TO backbone_app USING (true);
CREATE POLICY crossings ON app.channel_accounts FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.channel_accounts FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER keep BEFORE UPDATE OR DELETE ON app.channel_accounts FOR EACH ROW EXECUTE FUNCTION sec.t_keep_columns('id', 'workspace_id', 'platform', 'team');
GRANT SELECT ON app.channel_accounts TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.channel_accounts TO backbone_gov;
