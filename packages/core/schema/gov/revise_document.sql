-- A person who can see a document writes a new version of it (its title, its words or both). The
-- previous version is kept. What the words carry (untrusted, private, imported) is never lowered by
-- an edit: only a review lifts it.
CREATE FUNCTION gov.revise_document(p_document uuid, p_title text, p_content text, p_append text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := gov._person('not_by_runs');
  d record;
BEGIN
  SELECT * INTO d FROM app.documents WHERE workspace_id = sec.current_workspace() AND id = p_document;
  IF NOT FOUND OR (d.task_id IS NOT NULL AND NOT sec.task_visible(d.task_id)) THEN
    RAISE EXCEPTION 'not_found: no such document for this person';
  END IF;
  UPDATE app.documents SET title = coalesce(p_title, title), content = coalesce(p_content, content) || coalesce(p_append, ''),
                           updated_by = me, via_effect = NULL,
                           content_author = CASE WHEN p_content IS NOT NULL OR p_append IS NOT NULL THEN me ELSE content_author END
  WHERE workspace_id = d.workspace_id AND id = p_document;
  PERFORM gov._append('document.revised', p_document::text, jsonb_build_object(
    'version', (SELECT version FROM app.documents WHERE workspace_id = d.workspace_id AND id = p_document)));
  RETURN 1;
END
$$;
