-- A person speaking in a channel thread, through their paired identity, joins its task: they read
-- what it shows everyone, never what was kept for another.
CREATE FUNCTION gov.join_channel_thread(p_thread uuid, p_identity uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := gov._person('not_by_runs');
  t record;
BEGIN
  SELECT * INTO t FROM app.channel_threads x WHERE x.workspace_id = ws AND x.id = p_thread;
  IF NOT FOUND OR NOT EXISTS (SELECT FROM app.channel_identities i WHERE i.workspace_id = ws AND i.id = p_identity
                              AND i.person_id = me AND i.account_id = t.account_id) THEN
    RAISE EXCEPTION 'not_found: no such thread for this person''s channel identity';
  END IF;
  INSERT INTO app.task_people (workspace_id, task_id, person_id) VALUES (ws, t.task_id, me) ON CONFLICT DO NOTHING;
  PERFORM gov._append('channel.thread_joined', p_thread::text, jsonb_build_object('person', me));
  RETURN t.task_id;
END
$$;
