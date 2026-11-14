-- A recorded source: exactly what was read, its trust fixed at ingest by the database, never changed.
CREATE TABLE app.episodes (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source_kind text NOT NULL CHECK (source_kind IN ('file', 'sandbox', 'mcp', 'document', 'message', 'web', 'memory', 'knowledge')),
  source_ref text NOT NULL,
  trust text NOT NULL CHECK (trust IN ('trusted', 'untrusted')),
  sensitive boolean NOT NULL DEFAULT false,
  content text NOT NULL,
  content_hash text NOT NULL,
  recorded_by uuid NOT NULL,
  authored_by uuid,
  run_id uuid,
  task_id uuid,
  document_id uuid,
  document_version integer,
  connection_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, recorded_by) REFERENCES app.principals (workspace_id, id),
  FOREIGN KEY (workspace_id, authored_by) REFERENCES app.principals (workspace_id, id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES app.runs (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES app.tasks (workspace_id, id)
);
ALTER TABLE app.episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.episodes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.episodes AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.episodes FOR SELECT TO backbone_app USING (sec.episode_visible(task_id, run_id));
CREATE POLICY crossings ON app.episodes FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.episodes FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER evidence BEFORE UPDATE OR DELETE ON app.episodes FOR EACH ROW EXECUTE FUNCTION sec.t_evidence();
GRANT SELECT ON app.episodes TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.episodes TO backbone_gov;
-- Run lineage is queried set-wise against the immutable proposal ledger sequence.
CREATE INDEX episodes_run_sources ON app.episodes (workspace_id, run_id) INCLUDE (id, source_kind);
-- Classification stays in the definer function. A predicate-free trigger makes every queued
-- INSERT inspectable exactly; ordinary source kinds return without authority checks or writes.
CREATE CONSTRAINT TRIGGER material_source_receipt
AFTER INSERT ON app.episodes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION sec.t_material_episode_source();
ALTER TABLE app.episodes ENABLE ALWAYS TRIGGER material_source_receipt;
