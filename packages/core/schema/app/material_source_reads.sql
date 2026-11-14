-- The immutable preparation receipt binds three representations; it does not prove delivery.
CREATE TABLE app.material_source_reads (
  workspace_id uuid NOT NULL,
  read_key text NOT NULL CHECK (read_key ~ '^[a-f0-9]{64}$'),
  receipt_id uuid NOT NULL DEFAULT gen_random_uuid(),
  episode_id uuid NOT NULL,
  material_id text NOT NULL,
  project_id text NOT NULL,
  material_version integer NOT NULL CHECK (material_version > 0),
  generation integer NOT NULL CHECK (generation >= 0),
  original_sha256 text NOT NULL CHECK (original_sha256 ~ '^[a-f0-9]{64}$'),
  transformation jsonb NOT NULL CHECK (
    jsonb_typeof(transformation) IS NOT DISTINCT FROM 'object'
    AND jsonb_typeof(transformation -> 'kind') IS NOT DISTINCT FROM 'string'
    AND coalesce(length(transformation ->> 'kind'), 0) > 0
    AND jsonb_typeof(transformation -> 'version') IS NOT DISTINCT FROM 'string'
    AND coalesce(length(transformation ->> 'version'), 0) > 0
  ),
  episode_sha256 text NOT NULL CHECK (episode_sha256 ~ '^[a-f0-9]{64}$'),
  prepared_sha256 text NOT NULL CHECK (prepared_sha256 ~ '^[a-f0-9]{64}$'),
  source_kind text NOT NULL CHECK (source_kind IN ('file', 'mcp')),
  authored_by uuid,
  run_id uuid,
  requested_task_id uuid,
  connection_id uuid,
  tool text,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, read_key),
  UNIQUE (workspace_id, receipt_id),
  UNIQUE (workspace_id, episode_id),
  FOREIGN KEY (workspace_id, episode_id) REFERENCES app.episodes (workspace_id, id),
  FOREIGN KEY (workspace_id, material_id, project_id)
    REFERENCES app.material_source_identities (workspace_id, material_id, project_id),
  FOREIGN KEY (workspace_id, authored_by) REFERENCES app.principals (workspace_id, id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES app.runs (workspace_id, id),
  FOREIGN KEY (workspace_id, requested_task_id) REFERENCES app.tasks (workspace_id, id),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES app.connections (workspace_id, id),
  FOREIGN KEY (workspace_id, recorded_by) REFERENCES app.principals (workspace_id, id),
  CHECK ((source_kind = 'file' AND connection_id IS NULL AND tool IS NULL)
    OR (source_kind = 'mcp' AND connection_id IS NOT NULL AND run_id IS NOT NULL
      AND authored_by IS NULL AND requested_task_id IS NULL AND tool IS NOT NULL AND length(tool) > 0))
);
ALTER TABLE app.material_source_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.material_source_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.material_source_reads AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (workspace_id = (SELECT sec.current_workspace()))
  WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY crossings ON app.material_source_reads FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER evidence BEFORE UPDATE OR DELETE ON app.material_source_reads
  FOR EACH ROW EXECUTE FUNCTION sec.t_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.material_source_reads
  FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
REVOKE ALL ON app.material_source_reads FROM PUBLIC, backbone_app, backbone_operator;
GRANT SELECT, INSERT ON app.material_source_reads TO backbone_gov;
-- The crossing rejects contradictory original-byte observations for an immutable version.
CREATE INDEX material_source_reads_version ON app.material_source_reads
  (workspace_id, material_id, material_version) INCLUDE (original_sha256);
