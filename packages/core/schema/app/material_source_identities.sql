-- The first project/material association is a trusted Host observation, not filesystem proof.
CREATE TABLE app.material_source_identities (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  material_id text NOT NULL CHECK (octet_length(material_id) BETWEEN 1 AND 512),
  project_id text NOT NULL CHECK (octet_length(project_id) BETWEEN 1 AND 512),
  observed_by uuid NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, material_id),
  UNIQUE (workspace_id, material_id, project_id),
  FOREIGN KEY (workspace_id, observed_by) REFERENCES app.principals (workspace_id, id)
);
ALTER TABLE app.material_source_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.material_source_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.material_source_identities AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (workspace_id = (SELECT sec.current_workspace()))
  WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY crossings ON app.material_source_identities FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER evidence BEFORE UPDATE OR DELETE ON app.material_source_identities
  FOR EACH ROW EXECUTE FUNCTION sec.t_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.material_source_identities
  FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
REVOKE ALL ON app.material_source_identities FROM PUBLIC, backbone_app, backbone_operator;
GRANT SELECT, INSERT ON app.material_source_identities TO backbone_gov;
