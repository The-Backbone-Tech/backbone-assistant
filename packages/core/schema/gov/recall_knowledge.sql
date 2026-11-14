-- The run, while it acts, recalls accepted knowledge that holds now (a missing bound of its validity
-- is open) matching any of the words (all of it with none). Knowledge resting on untrusted content
-- is untrusted words: recalling it marks the run.
CREATE FUNCTION gov.recall_knowledge(p_run uuid, p_words text[], p_limit integer) RETURNS TABLE (statement text, topic text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  k record;
BEGIN
  IF sec.current_run() IS DISTINCT FROM p_run THEN
    RAISE EXCEPTION 'not_in_run: knowledge is recalled only by the run that acts';
  END IF;
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 500 THEN
    RAISE EXCEPTION 'invalid: recall between 1 and 500 statements';
  END IF;
  FOR k IN SELECT x.* FROM app.knowledge x JOIN gov.eligible_knowledge_sources eligible
             ON eligible.workspace_id=x.workspace_id AND eligible.candidate_id=x.candidate_id WHERE x.workspace_id = sec.current_workspace() AND x.status = 'accepted'
             AND (x.valid_from IS NULL OR x.valid_from <= clock_timestamp())
             AND (x.valid_to IS NULL OR x.valid_to > clock_timestamp())
             AND (coalesce(cardinality(p_words), 0) = 0
                  OR EXISTS (SELECT FROM unnest(p_words) w WHERE position(lower(w) IN lower(x.statement)) > 0))
           ORDER BY x.created_at LIMIT p_limit LOOP
    IF k.words_untrusted THEN
      PERFORM gov._mark(p_run, 'accepted company knowledge on the topic “' || k.topic || '” (its own words), which rests on untrusted content', NULL);
    END IF;
    statement := k.statement;
    topic := k.topic;
    RETURN NEXT;
  END LOOP;
END
$$;
