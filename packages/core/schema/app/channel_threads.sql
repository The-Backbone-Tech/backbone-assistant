-- A channel thread bound to a task. A group thread is read by everyone in it.
CREATE TABLE app.channel_threads (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  channel text NOT NULL,
  thread text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('direct', 'group')),
  task_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, account_id, channel, thread),
  FOREIGN KEY (workspace_id, account_id) REFERENCES app.channel_accounts (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES app.tasks (workspace_id, id)
);
ALTER TABLE app.channel_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.channel_threads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.channel_threads AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.channel_threads FOR SELECT TO backbone_app USING (sec.task_visible(task_id));
CREATE POLICY crossings ON app.channel_threads FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.channel_threads FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER keep BEFORE UPDATE OR DELETE ON app.channel_threads FOR EACH ROW EXECUTE FUNCTION sec.t_keep_columns('id', 'workspace_id', 'account_id', 'channel', 'thread', 'kind', 'task_id');
GRANT SELECT ON app.channel_threads TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.channel_threads TO backbone_gov;
