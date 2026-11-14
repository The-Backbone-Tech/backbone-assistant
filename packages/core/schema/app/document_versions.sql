-- Every earlier version of a document, as it was. Evidence: never changed.
CREATE TABLE app.document_versions (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  document_id uuid NOT NULL,
  version integer NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  updated_by uuid NOT NULL,
  content_author uuid NOT NULL,
  via_effect uuid,
  words_untrusted boolean NOT NULL,
  words_sensitive boolean NOT NULL,
  imported boolean NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, document_id, version),
  FOREIGN KEY (workspace_id, document_id) REFERENCES app.documents (workspace_id, id)
);
ALTER TABLE app.document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.document_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.document_versions AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.document_versions FOR SELECT TO backbone_app USING (EXISTS (SELECT FROM app.documents d WHERE d.workspace_id = document_versions.workspace_id AND d.id = document_versions.document_id));
CREATE POLICY crossings ON app.document_versions FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.document_versions FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER evidence BEFORE UPDATE OR DELETE ON app.document_versions FOR EACH ROW EXECUTE FUNCTION sec.t_evidence();
GRANT SELECT ON app.document_versions TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.document_versions TO backbone_gov;
