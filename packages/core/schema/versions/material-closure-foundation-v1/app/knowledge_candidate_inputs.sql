-- Material closure foundation v1. Canonical versioned source; see its closed manifest.
CREATE TABLE app.knowledge_candidate_inputs (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  candidate_id uuid NOT NULL,
  format_version integer NOT NULL CHECK (format_version = 1),
  boundary_seq bigint NOT NULL CHECK (boundary_seq > 0),
  boundary_hash text NOT NULL CHECK (boundary_hash ~ '^[a-f0-9]{64}$'),
  capture_seq bigint NOT NULL,
  capture_hash text NOT NULL CHECK (capture_hash ~ '^[a-f0-9]{64}$'),
  proposal_seq bigint GENERATED ALWAYS AS (capture_seq + 1) STORED,
  proposed_by uuid NOT NULL,
  run_id uuid,
  run_fence bigint,
  run_task_id uuid,
  on_behalf_of uuid,
  run_tainted_untrusted boolean,
  run_tainted_sensitive boolean,
  words_untrusted boolean NOT NULL,
  kept boolean NOT NULL,
  claim_digest text NOT NULL CHECK (claim_digest ~ '^[a-f0-9]{64}$'),
  input_manifest jsonb NOT NULL,
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, candidate_id),
  UNIQUE (workspace_id, proposal_seq),
  CONSTRAINT candidate_inputs_capture_order CHECK (
    capture_seq >= boundary_seq AND capture_seq < 9223372036854775807
  ),
  CONSTRAINT candidate_inputs_run_snapshot CHECK (
    (run_id IS NULL AND run_fence IS NULL AND run_task_id IS NULL
      AND run_tainted_untrusted IS NULL AND run_tainted_sensitive IS NULL)
    OR (run_id IS NOT NULL AND run_fence IS NOT NULL AND run_fence > 0
      AND run_task_id IS NOT NULL AND run_tainted_untrusted IS NOT NULL
      AND run_tainted_sensitive IS NOT NULL)
  ),
  CONSTRAINT candidate_inputs_manifest_shape CHECK (
    jsonb_typeof(input_manifest) IS NOT DISTINCT FROM 'object'
    AND input_manifest -> 'version' IS NOT DISTINCT FROM '1'::jsonb
    AND jsonb_typeof(input_manifest -> 'complete') IS NOT DISTINCT FROM 'boolean'
    AND jsonb_typeof(input_manifest -> 'sources') IS NOT DISTINCT FROM 'array'
    AND jsonb_typeof(input_manifest -> 'read_edges') IS NOT DISTINCT FROM 'array'
    AND jsonb_typeof(input_manifest -> 'unknown') IS NOT DISTINCT FROM 'array'
    AND CASE WHEN input_manifest -> 'complete' = 'true'::jsonb THEN
      CASE WHEN jsonb_typeof(input_manifest -> 'unknown') = 'array'
        THEN jsonb_array_length(input_manifest -> 'unknown') = 0 ELSE false END
      ELSE CASE WHEN jsonb_typeof(input_manifest -> 'unknown') = 'array'
        THEN jsonb_array_length(input_manifest -> 'unknown') > 0 ELSE false END END
  ),
  CONSTRAINT candidate_inputs_candidate_fk FOREIGN KEY (workspace_id, candidate_id)
    REFERENCES app.knowledge_candidates (workspace_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, boundary_seq) REFERENCES app.ledger (workspace_id, seq),
  FOREIGN KEY (workspace_id, capture_seq) REFERENCES app.ledger (workspace_id, seq),
  FOREIGN KEY (workspace_id, proposed_by) REFERENCES app.principals (workspace_id, id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES app.runs (workspace_id, id),
  FOREIGN KEY (workspace_id, run_task_id) REFERENCES app.tasks (workspace_id, id),
  FOREIGN KEY (workspace_id, on_behalf_of) REFERENCES app.principals (workspace_id, id)
);
ALTER TABLE app.knowledge_candidate_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.knowledge_candidate_inputs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.knowledge_candidate_inputs AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (workspace_id = (SELECT sec.current_workspace()))
  WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY crossings ON app.knowledge_candidate_inputs FOR ALL TO backbone_gov
  USING (true) WITH CHECK (true);
CREATE TRIGGER evidence BEFORE UPDATE OR DELETE ON app.knowledge_candidate_inputs
  FOR EACH ROW EXECUTE FUNCTION sec.t_evidence();
ALTER TABLE app.knowledge_candidate_inputs ENABLE ALWAYS TRIGGER evidence;
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.knowledge_candidate_inputs
  FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
ALTER TABLE app.knowledge_candidate_inputs ENABLE ALWAYS TRIGGER no_truncate;
REVOKE ALL ON app.knowledge_candidate_inputs FROM PUBLIC, backbone_app, backbone_operator;
GRANT SELECT, INSERT ON app.knowledge_candidate_inputs TO backbone_gov;
