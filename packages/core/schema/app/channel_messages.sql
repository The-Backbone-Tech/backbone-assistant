-- What went out to a channel thread, or came in from it.
CREATE TABLE app.channel_messages (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  thread_id uuid NOT NULL,
  message_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, thread_id, message_id),
  FOREIGN KEY (workspace_id, thread_id) REFERENCES app.channel_threads (workspace_id, id),
  FOREIGN KEY (workspace_id, message_id) REFERENCES app.messages (workspace_id, id)
);
ALTER TABLE app.channel_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.channel_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.channel_messages AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.channel_messages FOR SELECT TO backbone_app USING (EXISTS (SELECT FROM app.messages m WHERE m.workspace_id = channel_messages.workspace_id AND m.id = channel_messages.message_id));
CREATE POLICY crossings ON app.channel_messages FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.channel_messages FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER evidence BEFORE UPDATE OR DELETE ON app.channel_messages FOR EACH ROW EXECUTE FUNCTION sec.t_evidence();
GRANT SELECT ON app.channel_messages TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.channel_messages TO backbone_gov;
