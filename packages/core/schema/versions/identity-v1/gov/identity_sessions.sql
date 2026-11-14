-- Tenant identity state is crossing-only, including for the service role.
CREATE TABLE app.identity_sessions (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'), principal_id uuid NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz, PRIMARY KEY(workspace_id,token_hash), FOREIGN KEY(workspace_id,principal_id) REFERENCES app.principals(workspace_id,id)
);
ALTER TABLE app.identity_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.identity_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.identity_sessions AS RESTRICTIVE FOR ALL TO PUBLIC USING(workspace_id=sec.current_workspace()) WITH CHECK(workspace_id=sec.current_workspace());
CREATE POLICY crossings ON app.identity_sessions FOR ALL TO backbone_gov USING(true) WITH CHECK(true);
REVOKE ALL ON app.identity_sessions FROM PUBLIC, backbone_app, backbone_operator;

GRANT SELECT,INSERT,UPDATE,DELETE ON app.identity_sessions TO backbone_gov;
