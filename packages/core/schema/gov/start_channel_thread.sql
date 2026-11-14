-- A person starts a task by writing in a channel thread, through their own paired identity: the
-- task, its first message and the thread's binding, at once. A group thread is never its person's
-- alone.
CREATE FUNCTION gov.start_channel_thread(p_title text, p_content text, p_account uuid, p_channel text, p_thread text, p_kind text,
                                         p_identity uuid) RETURNS TABLE (task_id uuid, thread_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := gov._person('not_by_runs');
  task uuid := gen_random_uuid();
  thread uuid := gen_random_uuid();
  message uuid := gen_random_uuid();
BEGIN
  IF NOT EXISTS (SELECT FROM app.channel_identities i WHERE i.workspace_id = ws AND i.id = p_identity AND i.person_id = me
                 AND i.account_id = p_account) THEN
    RAISE EXCEPTION 'denied: a person writes in a channel only as their own paired identity';
  END IF;
  INSERT INTO app.tasks (workspace_id, id, title, visibility, kind, requested_by, on_behalf_of)
  VALUES (ws, task, coalesce(p_title, 'Conversation'), 'private', 'channel', me, me);
  INSERT INTO app.messages (workspace_id, id, task_id, role, author_id, content) VALUES (ws, message, task, 'person', me, p_content);
  INSERT INTO app.channel_threads (workspace_id, id, account_id, channel, thread, kind, task_id)
  VALUES (ws, thread, p_account, p_channel, p_thread, coalesce(p_kind, 'group'), task);
  INSERT INTO app.channel_messages (workspace_id, thread_id, message_id, direction) VALUES (ws, thread, message, 'inbound');
  PERFORM gov._append('channel.thread_started', thread::text, jsonb_build_object('task', task, 'kind', coalesce(p_kind, 'group')));
  RETURN QUERY SELECT task, thread;
END
$$;
