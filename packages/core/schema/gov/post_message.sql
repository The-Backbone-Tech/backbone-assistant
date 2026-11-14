-- A person writes in a task they can see, as themself.
CREATE FUNCTION gov.post_message(p_task uuid, p_author uuid, p_content text, p_workspace uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid;
  new_id uuid := gen_random_uuid();
BEGIN
  IF p_workspace IS NOT NULL AND p_workspace IS DISTINCT FROM sec.current_workspace() THEN
    RAISE EXCEPTION 'denied: the message names another workspace than the session''s';
  END IF;
  me := gov._person();
  IF p_author IS DISTINCT FROM me THEN
    RAISE EXCEPTION 'denied: a person writes only as themself';
  END IF;
  IF NOT sec.task_visible(p_task) THEN
    RAISE EXCEPTION 'not_found: no such task for this person';
  END IF;
  IF p_content IS NULL OR length(p_content) = 0 THEN
    RAISE EXCEPTION 'invalid: a message has words';
  END IF;
  INSERT INTO app.messages (workspace_id, id, task_id, role, author_id, content)
  VALUES (sec.current_workspace(), new_id, p_task, 'person', me, p_content);
  PERFORM gov._append('message.posted', new_id::text, jsonb_build_object('task', p_task, 'role', 'person'));
  RETURN new_id;
END
$$;
