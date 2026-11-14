-- What reading a document carries into a run, as the reasons its marks give: untrusted when its
-- words were imported and not reviewed, or written by work that had read untrusted content (its
-- title quoted as its own words, bounded); private material when it is marked, written by work that
-- touched private material, or a person's words in a private task. Private material from another
-- task than the run's is from beyond its conversation.
CREATE FUNCTION gov._document_reasons(p_document uuid, p_run uuid, OUT untrusted text, OUT sensitive text, OUT elsewhere text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  d record;
  t record;
  title text;
BEGIN
  SELECT * INTO d FROM app.documents x WHERE x.workspace_id = ws AND x.id = p_document;
  SELECT * INTO t FROM app.tasks x WHERE x.workspace_id = ws AND x.id = d.task_id;
  title := CASE WHEN length(d.title) > 80 THEN rtrim(left(d.title, 79)) || '…' ELSE d.title END;
  IF d.imported THEN
    untrusted := 'a document titled “' || title || '” (its own words), imported from another agent’s store and not yet reviewed';
  ELSIF d.words_untrusted THEN
    untrusted := 'a document titled “' || title || '” (its own words), written by work that had read untrusted content';
  END IF;
  IF d.sensitive THEN
    sensitive := 'the document “' || d.title || '”, marked sensitive';
  ELSIF d.words_sensitive THEN
    sensitive := 'the document “' || d.title || '”, written by work that had touched private material';
  ELSIF t.visibility = 'private' AND sec.principal_kind(d.content_author) = 'person' THEN
    sensitive := 'the document “' || d.title || '”, private to ' || gov._person_name(t.on_behalf_of);
  END IF;
  IF sensitive IS NOT NULL AND d.task_id IS DISTINCT FROM (SELECT r.task_id FROM app.runs r WHERE r.workspace_id = ws AND r.id = p_run) THEN
    elsewhere := sensitive;
  END IF;
END
$$;
