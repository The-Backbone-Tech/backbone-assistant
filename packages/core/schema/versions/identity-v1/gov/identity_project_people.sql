-- Tenant identity state is crossing-only, including for the service role.
CREATE TABLE app.identity_project_people (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  project_id uuid NOT NULL, person_id uuid NOT NULL, access text NOT NULL CHECK(access IN ('viewer','editor')), PRIMARY KEY(workspace_id,project_id,person_id), FOREIGN KEY(workspace_id,project_id) REFERENCES app.identity_projects(workspace_id,project_id), FOREIGN KEY(workspace_id,person_id) REFERENCES app.principals(workspace_id,id)
);
ALTER TABLE app.identity_project_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.identity_project_people FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.identity_project_people AS RESTRICTIVE FOR ALL TO PUBLIC USING(workspace_id=sec.current_workspace()) WITH CHECK(workspace_id=sec.current_workspace());
CREATE POLICY crossings ON app.identity_project_people FOR ALL TO backbone_gov USING(true) WITH CHECK(true);
REVOKE ALL ON app.identity_project_people FROM PUBLIC, backbone_app, backbone_operator;

GRANT SELECT,INSERT,UPDATE,DELETE ON app.identity_project_people TO backbone_gov;
