-- Tenant identity state is crossing-only, including for the service role.
CREATE TABLE app.identity_projects (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  project_id uuid NOT NULL, owner_id uuid NOT NULL, PRIMARY KEY(workspace_id,project_id), FOREIGN KEY(workspace_id,owner_id) REFERENCES app.principals(workspace_id,id)
);
ALTER TABLE app.identity_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.identity_projects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.identity_projects AS RESTRICTIVE FOR ALL TO PUBLIC USING(workspace_id=sec.current_workspace()) WITH CHECK(workspace_id=sec.current_workspace());
CREATE POLICY crossings ON app.identity_projects FOR ALL TO backbone_gov USING(true) WITH CHECK(true);
REVOKE ALL ON app.identity_projects FROM PUBLIC, backbone_app, backbone_operator;

GRANT SELECT,INSERT,UPDATE,DELETE ON app.identity_projects TO backbone_gov;
