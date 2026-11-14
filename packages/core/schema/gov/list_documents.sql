-- The document titles a run, while it acts, is shown: those its person may see, matching any of
-- the words. A title whose words came from untrusted content is withheld (and never matches); a
-- title of private material marks the run.
CREATE FUNCTION gov.list_documents(p_run uuid, p_words text[], p_limit integer) RETURNS TABLE (id uuid, title text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  person uuid;
  run_task uuid;
  d record;
  withheld boolean;
  private boolean;
BEGIN
  IF sec.current_run() IS DISTINCT FROM p_run THEN
    RAISE EXCEPTION 'not_in_run: documents are listed for the run that acts';
  END IF;
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 500 THEN
    RAISE EXCEPTION 'invalid: list between 1 and 500 documents';
  END IF;
  person := gov._run_person(p_run);
  SELECT r.task_id INTO run_task FROM app.runs r WHERE r.workspace_id = ws AND r.id = p_run;
  FOR d IN SELECT x.*, t.visibility FROM app.documents x LEFT JOIN app.tasks t ON t.workspace_id = x.workspace_id AND t.id = x.task_id
           WHERE x.workspace_id = ws AND (x.task_id IS NULL OR sec.task_visible_to(x.task_id, person))
           ORDER BY x.created_at, x.id LIMIT p_limit LOOP
    withheld := d.words_untrusted OR d.imported;
    IF coalesce(cardinality(p_words), 0) > 0 AND (withheld OR NOT EXISTS (
         SELECT FROM unnest(p_words) w WHERE position(lower(w) IN lower(d.title)) > 0)) THEN
      CONTINUE;
    END IF;
    private := d.sensitive OR d.words_sensitive OR (d.visibility = 'private' AND sec.principal_kind(d.content_author) = 'person');
    IF private AND NOT withheld THEN
      PERFORM gov._mark(p_run, NULL, 'the titles of documents that hold private material',
                        CASE WHEN d.task_id IS DISTINCT FROM run_task THEN 'the titles of documents that hold private material' END);
    END IF;
    id := d.id;
    title := CASE WHEN withheld THEN NULL ELSE d.title END;
    RETURN NEXT;
  END LOOP;
END
$$;
