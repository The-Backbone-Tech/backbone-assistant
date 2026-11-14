-- A person writes a new document: a workspace document, or one in a task they can see.
CREATE FUNCTION gov.create_document(p_task uuid, p_title text, p_content text, p_by uuid, p_workspace uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid;
  new_id uuid := gen_random_uuid();
BEGIN
  IF p_workspace IS NOT NULL AND p_workspace IS DISTINCT FROM sec.current_workspace() THEN
    RAISE EXCEPTION 'denied: the document names another workspace than the session''s';
  END IF;
  me := gov._person('not_by_runs');
  IF p_by IS NOT NULL AND p_by IS DISTINCT FROM me THEN
    RAISE EXCEPTION 'denied: a person writes only as themself';
  END IF;
  IF p_task IS NOT NULL AND NOT sec.task_visible(p_task) THEN
    RAISE EXCEPTION 'not_found: no such task for this person';
  END IF;
  INSERT INTO app.documents (workspace_id, id, task_id, title, content, updated_by, content_author)
  VALUES (sec.current_workspace(), new_id, p_task, coalesce(p_title, 'Untitled'), coalesce(p_content, ''), me, me);
  PERFORM gov._append('document.created', new_id::text, jsonb_build_object('task', p_task, 'version', 1));
  RETURN new_id;
END
$$;
