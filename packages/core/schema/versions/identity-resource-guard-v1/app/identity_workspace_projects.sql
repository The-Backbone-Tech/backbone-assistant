-- A legacy task explicitly published to the workspace keeps that audience for future people.
CREATE TABLE app.identity_workspace_projects(workspace_id uuid NOT NULL,project_id uuid NOT NULL,PRIMARY KEY(workspace_id,project_id),FOREIGN KEY(workspace_id,project_id) REFERENCES app.identity_projects(workspace_id,project_id));
ALTER TABLE app.identity_workspace_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.identity_workspace_projects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.identity_workspace_projects AS RESTRICTIVE FOR ALL TO PUBLIC USING(workspace_id=sec.current_workspace()) WITH CHECK(workspace_id=sec.current_workspace());
CREATE POLICY crossings ON app.identity_workspace_projects FOR ALL TO backbone_gov USING(true) WITH CHECK(true);
REVOKE ALL ON app.identity_workspace_projects FROM PUBLIC,backbone_app,backbone_operator;
GRANT SELECT,INSERT,DELETE ON app.identity_workspace_projects TO backbone_gov;
