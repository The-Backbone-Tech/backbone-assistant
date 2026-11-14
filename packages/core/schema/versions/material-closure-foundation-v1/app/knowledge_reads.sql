-- Material closure foundation v1. Canonical versioned source; see its closed manifest.
CREATE TABLE app.knowledge_reads (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  read_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  batch_ordinal integer NOT NULL CHECK (batch_ordinal BETWEEN 1 AND 100),
  read_seq bigint NOT NULL CHECK (read_seq > 0),
  receiving_run_id uuid NOT NULL,
  receiving_fence bigint NOT NULL CHECK (receiving_fence > 0),
  receiving_agent_id uuid NOT NULL,
  receiving_person_id uuid NOT NULL,
  receiving_task_id uuid NOT NULL,
  knowledge_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  source_snapshot jsonb NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_sensitive boolean NOT NULL,
  source_elsewhere boolean NOT NULL CHECK (NOT source_elsewhere OR source_sensitive),
  read_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, read_id),
  UNIQUE (workspace_id, batch_id, batch_ordinal),
  UNIQUE (workspace_id, batch_id, knowledge_id),
  FOREIGN KEY (workspace_id, read_seq) REFERENCES app.ledger(workspace_id, seq),
  FOREIGN KEY (workspace_id, receiving_run_id) REFERENCES app.runs(workspace_id, id),
  FOREIGN KEY (workspace_id, receiving_agent_id) REFERENCES app.principals(workspace_id, id),
  FOREIGN KEY (workspace_id, receiving_person_id) REFERENCES app.principals(workspace_id, id),
  FOREIGN KEY (workspace_id, receiving_task_id) REFERENCES app.tasks(workspace_id, id),
  FOREIGN KEY (workspace_id, knowledge_id) REFERENCES app.knowledge(workspace_id, id),
  FOREIGN KEY (workspace_id, candidate_id) REFERENCES app.knowledge_candidates(workspace_id, id),
  CONSTRAINT knowledge_read_snapshot CHECK (
    jsonb_typeof(source_snapshot) IS NOT DISTINCT FROM 'object'
    AND source_snapshot ->> 'format' IS NOT DISTINCT FROM 'knowledge-personal-closure-v1'
    AND source_snapshot ->> 'knowledge_id' IS NOT DISTINCT FROM knowledge_id::text
    AND source_snapshot ->> 'candidate_id' IS NOT DISTINCT FROM candidate_id::text
    AND source_sha256 = encode(sha256(convert_to(source_snapshot::text, 'UTF8')), 'hex')
  )
);
ALTER TABLE app.knowledge_reads OWNER TO backbone_owner;
ALTER TABLE app.knowledge_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.knowledge_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.knowledge_reads AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (workspace_id = (SELECT sec.current_workspace()))
  WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY crossings ON app.knowledge_reads FOR ALL TO backbone_gov
  USING (true) WITH CHECK (true);
CREATE TRIGGER evidence BEFORE UPDATE OR DELETE ON app.knowledge_reads
  FOR EACH ROW EXECUTE FUNCTION sec.t_evidence();
ALTER TABLE app.knowledge_reads ENABLE ALWAYS TRIGGER evidence;
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.knowledge_reads
  FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
ALTER TABLE app.knowledge_reads ENABLE ALWAYS TRIGGER no_truncate;
CREATE INDEX knowledge_reads_receiver_cut
  ON app.knowledge_reads(workspace_id, receiving_run_id, read_seq, read_id);
REVOKE ALL ON app.knowledge_reads FROM PUBLIC, backbone_app, backbone_operator;
GRANT SELECT, INSERT ON app.knowledge_reads TO backbone_gov;
-- No app SELECT or person resolveRead crossing. Gov INSERT is a native code privilege,
-- not an untrusted writer interface. Source authority is derived by the crossing below.

-- Resource-control prerequisite for the bounded cursor, not an authority shortcut.
CREATE INDEX knowledge_traced_scan
  ON app.knowledge(workspace_id,status,created_at,id);
