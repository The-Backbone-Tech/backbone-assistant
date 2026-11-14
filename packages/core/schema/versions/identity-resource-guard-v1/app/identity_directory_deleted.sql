-- Deletion hides the SCIM resource without releasing its immutable account binding.
CREATE TABLE app.identity_directory_deleted(workspace_id uuid NOT NULL,principal_id uuid NOT NULL,PRIMARY KEY(workspace_id,principal_id),FOREIGN KEY(workspace_id,principal_id) REFERENCES app.identity_directory(workspace_id,principal_id));
ALTER TABLE app.identity_directory_deleted ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.identity_directory_deleted FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.identity_directory_deleted AS RESTRICTIVE FOR ALL TO PUBLIC USING(workspace_id=sec.current_workspace()) WITH CHECK(workspace_id=sec.current_workspace());
CREATE POLICY crossings ON app.identity_directory_deleted FOR ALL TO backbone_gov USING(true) WITH CHECK(true);
REVOKE ALL ON app.identity_directory_deleted FROM PUBLIC,backbone_app,backbone_operator;
GRANT SELECT,INSERT ON app.identity_directory_deleted TO backbone_gov;
