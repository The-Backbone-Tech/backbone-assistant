-- A tidy-up run looks over its person's open promises (made to them, or by their agents) and finds
-- the late ones. Each finding quotes the work that made the promise.
CREATE FUNCTION gov.tidy_up() RETURNS TABLE (finding_kind text, subject uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  run uuid := sec.current_run();
  person uuid;
  c record;
BEGIN
  IF run IS NULL THEN
    RAISE EXCEPTION 'not_in_run: a tidy-up is a run''s';
  END IF;
  person := gov._run_person(run);
  FOR c IN SELECT * FROM app.commitments x WHERE x.workspace_id = ws AND x.status = 'open' AND x.due < (clock_timestamp() AT TIME ZONE 'UTC')::date
             AND (x.to_person = person OR x.agent_id IN (SELECT p.id FROM app.principals p WHERE p.workspace_id = ws AND p.owner_id = person))
           ORDER BY x.due, x.created_at LOOP
    PERFORM gov._quote_run(run, c.run_id);
    finding_kind := 'commitment_late';
    subject := c.id;
    RETURN NEXT;
  END LOOP;
END
$$;
