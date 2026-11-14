-- A withdrawal needs no episode. Exact timestamp spelling is evidence, never normalized for replay.
CREATE TABLE app.material_source_withdrawals (
  workspace_id uuid NOT NULL,
  event_id text NOT NULL CHECK (event_id ~ '^[a-f0-9]{64}$'),
  receipt_id uuid NOT NULL DEFAULT gen_random_uuid(),
  material_id text NOT NULL,
  project_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  generation integer NOT NULL CHECK (generation >= 0 AND generation = sequence - 1),
  observed_version integer NOT NULL CHECK (observed_version > 0),
  event_at text NOT NULL,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, event_id),
  UNIQUE (workspace_id, receipt_id),
  UNIQUE (workspace_id, material_id, generation),
  FOREIGN KEY (workspace_id, material_id, project_id)
    REFERENCES app.material_source_identities (workspace_id, material_id, project_id),
  FOREIGN KEY (workspace_id, recorded_by) REFERENCES app.principals (workspace_id, id)
);
ALTER TABLE app.material_source_withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.material_source_withdrawals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.material_source_withdrawals AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (workspace_id = (SELECT sec.current_workspace()))
  WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY crossings ON app.material_source_withdrawals FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER evidence BEFORE UPDATE OR DELETE ON app.material_source_withdrawals
  FOR EACH ROW EXECUTE FUNCTION sec.t_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.material_source_withdrawals
  FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
REVOKE ALL ON app.material_source_withdrawals FROM PUBLIC, backbone_app, backbone_operator;
GRANT SELECT, INSERT ON app.material_source_withdrawals TO backbone_gov;
