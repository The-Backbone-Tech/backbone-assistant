-- Tenant identity state is crossing-only, including for the service role.
CREATE TABLE app.identity_agents (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  person_id uuid NOT NULL, carrier text NOT NULL, agent_id uuid NOT NULL, mandate_id uuid NOT NULL, PRIMARY KEY(workspace_id,person_id,carrier), FOREIGN KEY(workspace_id,person_id) REFERENCES app.principals(workspace_id,id), FOREIGN KEY(workspace_id,agent_id) REFERENCES app.principals(workspace_id,id), FOREIGN KEY(workspace_id,mandate_id) REFERENCES app.mandates(workspace_id,id)
);
ALTER TABLE app.identity_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.identity_agents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.identity_agents AS RESTRICTIVE FOR ALL TO PUBLIC USING(workspace_id=sec.current_workspace()) WITH CHECK(workspace_id=sec.current_workspace());
CREATE POLICY crossings ON app.identity_agents FOR ALL TO backbone_gov USING(true) WITH CHECK(true);
REVOKE ALL ON app.identity_agents FROM PUBLIC, backbone_app, backbone_operator;

GRANT SELECT,INSERT,UPDATE,DELETE ON app.identity_agents TO backbone_gov;
