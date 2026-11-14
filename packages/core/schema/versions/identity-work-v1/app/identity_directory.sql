-- Identity resource state remains tenant-walled and crossing-only.
CREATE TABLE app.identity_directory (workspace_id uuid NOT NULL REFERENCES app.workspaces(id), principal_id uuid NOT NULL, issuer text NOT NULL, subject text NOT NULL, user_name text NOT NULL, display_name text, revision bigint NOT NULL DEFAULT 1, PRIMARY KEY(workspace_id,principal_id), UNIQUE(workspace_id,issuer,user_name), FOREIGN KEY(workspace_id,principal_id) REFERENCES app.principals(workspace_id,id), FOREIGN KEY(workspace_id,issuer,subject) REFERENCES app.identity_accounts(workspace_id,issuer,subject));
ALTER TABLE app.identity_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.identity_directory FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.identity_directory AS RESTRICTIVE FOR ALL TO PUBLIC USING(workspace_id=sec.current_workspace()) WITH CHECK(workspace_id=sec.current_workspace());
CREATE POLICY crossings ON app.identity_directory FOR ALL TO backbone_gov USING(true) WITH CHECK(true);
REVOKE ALL ON app.identity_directory FROM PUBLIC,backbone_app,backbone_operator;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.identity_directory TO backbone_gov;
