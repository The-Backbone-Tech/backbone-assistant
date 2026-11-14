-- A working document. It keeps its identity; every write keeps the previous version; its words carry what wrote them.
CREATE TABLE app.documents (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  task_id uuid,
  title text NOT NULL,
  content text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL,
  content_author uuid NOT NULL,
  via_effect uuid,
  sensitive boolean NOT NULL DEFAULT false,
  words_untrusted boolean NOT NULL DEFAULT false,
  words_sensitive boolean NOT NULL DEFAULT false,
  imported boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES app.tasks (workspace_id, id),
  FOREIGN KEY (workspace_id, updated_by) REFERENCES app.principals (workspace_id, id)
);
ALTER TABLE app.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.documents AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.documents FOR SELECT TO backbone_app USING (task_id IS NULL OR sec.task_visible(task_id));
CREATE POLICY crossings ON app.documents FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.documents FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER versions BEFORE UPDATE OR DELETE ON app.documents FOR EACH ROW EXECUTE FUNCTION sec.t_document();
GRANT SELECT ON app.documents TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.documents TO backbone_gov;
