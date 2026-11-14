-- Tenant identity state is crossing-only, including for the service role.
CREATE TABLE app.identity_invitations (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'), role text NOT NULL CHECK(role IN ('admin','member','guest')), invited_by uuid NOT NULL, expires_at timestamptz NOT NULL, accepted_by uuid, PRIMARY KEY(workspace_id,token_hash), FOREIGN KEY(workspace_id,invited_by) REFERENCES app.principals(workspace_id,id), FOREIGN KEY(workspace_id,accepted_by) REFERENCES app.principals(workspace_id,id)
);
ALTER TABLE app.identity_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.identity_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.identity_invitations AS RESTRICTIVE FOR ALL TO PUBLIC USING(workspace_id=sec.current_workspace()) WITH CHECK(workspace_id=sec.current_workspace());
CREATE POLICY crossings ON app.identity_invitations FOR ALL TO backbone_gov USING(true) WITH CHECK(true);
REVOKE ALL ON app.identity_invitations FROM PUBLIC, backbone_app, backbone_operator;

GRANT SELECT,INSERT,UPDATE,DELETE ON app.identity_invitations TO backbone_gov;
