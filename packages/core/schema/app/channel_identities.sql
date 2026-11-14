-- A person's account on a channel, paired through a one-time link the person completes.
CREATE TABLE app.channel_identities (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  external_id text NOT NULL,
  link_hash text NOT NULL UNIQUE,
  person_id uuid,
  paired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES app.channel_accounts (workspace_id, id),
  FOREIGN KEY (workspace_id, person_id) REFERENCES app.principals (workspace_id, id)
);
ALTER TABLE app.channel_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.channel_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.channel_identities AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.channel_identities FOR SELECT TO backbone_app USING (person_id = sec.viewer());
CREATE POLICY crossings ON app.channel_identities FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.channel_identities FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER keep BEFORE UPDATE OR DELETE ON app.channel_identities FOR EACH ROW EXECUTE FUNCTION sec.t_keep_columns('id', 'workspace_id', 'account_id', 'external_id', 'link_hash');
GRANT SELECT ON app.channel_identities TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.channel_identities TO backbone_gov;
