-- Tenant identity state is crossing-only, including for the service role.
CREATE TABLE app.identity_accounts (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  principal_id uuid NOT NULL, issuer text NOT NULL CHECK(length(issuer) BETWEEN 1 AND 2048), subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 512), PRIMARY KEY(workspace_id,issuer,subject), UNIQUE(workspace_id,principal_id), FOREIGN KEY(workspace_id,principal_id) REFERENCES app.principals(workspace_id,id)
);
ALTER TABLE app.identity_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.identity_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.identity_accounts AS RESTRICTIVE FOR ALL TO PUBLIC USING(workspace_id=sec.current_workspace()) WITH CHECK(workspace_id=sec.current_workspace());
CREATE POLICY crossings ON app.identity_accounts FOR ALL TO backbone_gov USING(true) WITH CHECK(true);
REVOKE ALL ON app.identity_accounts FROM PUBLIC, backbone_app, backbone_operator;

GRANT SELECT,INSERT,UPDATE,DELETE ON app.identity_accounts TO backbone_gov;
