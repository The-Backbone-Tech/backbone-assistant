-- The run, while it acts, recalls its person's memory. Recalling marks it: a person's memory is
-- private material, and memory written by work that had read untrusted content is untrusted words.
CREATE FUNCTION gov.recall_memory(p_run uuid, p_limit integer) RETURNS TABLE (id uuid, content text, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  person uuid;
  name text;
  any_untrusted boolean;
  n integer;
BEGIN
  IF sec.current_run() IS DISTINCT FROM p_run THEN
    RAISE EXCEPTION 'not_in_run: memory is recalled only by the run that acts';
  END IF;
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid: recall between 1 and 1000 memories';
  END IF;
  person := sec.acting_for();
  SELECT p.name INTO name FROM app.principals p WHERE p.workspace_id = ws AND p.id = person;
  SELECT count(*), bool_or(m.words_untrusted) INTO n, any_untrusted FROM (
    SELECT m.words_untrusted FROM app.memory m WHERE m.workspace_id = ws AND m.owner_id = person AND m.forgotten_at IS NULL
    ORDER BY m.created_at LIMIT p_limit) m;
  IF n > 0 THEN
    PERFORM gov._mark(p_run,
      CASE WHEN any_untrusted THEN name || '’s memory, written by work that had read untrusted content' END,
      name || '’s memory');
  END IF;
  RETURN QUERY SELECT m.id, m.content, m.created_at FROM app.memory m
    WHERE m.workspace_id = ws AND m.owner_id = person AND m.forgotten_at IS NULL ORDER BY m.created_at LIMIT p_limit;
END
$$;
