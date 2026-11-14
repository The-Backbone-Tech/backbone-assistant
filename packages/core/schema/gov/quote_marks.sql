-- A run, while it acts, says what other work its digest quotes: effects, questions, runs, tasks,
-- imported memory proposals. It takes what each carries (I-7): a quoted run's marks,
-- a private task's words, an imported memory nobody accepted. Entries that name nothing are ignored.
CREATE FUNCTION gov.quote_marks(p_run uuid, p_quotes jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me record;
  q uuid;
  p record;
BEGIN
  IF sec.current_run() IS DISTINCT FROM p_run THEN
    RAISE EXCEPTION 'not_in_run: only the run that acts says what it quotes';
  END IF;
  IF jsonb_typeof(p_quotes) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid: quotes are named by kind';
  END IF;
  SELECT r.task_id, gov._run_person(r.id) AS person INTO me FROM app.runs r WHERE r.workspace_id = ws AND r.id = p_run;
  FOR q IN
    SELECT e.run_id FROM app.effects e WHERE e.workspace_id = ws AND e.id::text IN (SELECT gov._quoted_ids(p_quotes, 'effects'))
    UNION ALL
    SELECT e.run_id FROM app.decisions d JOIN app.effects e ON e.workspace_id = d.workspace_id AND e.id = d.subject_id
    WHERE d.workspace_id = ws AND d.id::text IN (SELECT gov._quoted_ids(p_quotes, 'decisions'))
    UNION ALL
    SELECT r.id FROM app.runs r WHERE r.workspace_id = ws AND r.id::text IN (SELECT gov._quoted_ids(p_quotes, 'runs'))
  LOOP
    IF q IS NOT NULL THEN
      PERFORM gov._quote_run(p_run, q);
    END IF;
  END LOOP;
  IF EXISTS (SELECT FROM app.tasks t WHERE t.workspace_id = ws AND t.id::text IN (SELECT gov._quoted_ids(p_quotes, 'tasks'))
             AND t.visibility = 'private' AND t.id <> me.task_id) THEN
    PERFORM gov._mark(p_run, NULL, 'private tasks whose words it quoted', 'private tasks whose words it quoted');
  END IF;
  FOR p IN SELECT * FROM app.memory_proposals mp WHERE mp.workspace_id = ws AND mp.id::text IN (SELECT gov._quoted_ids(p_quotes, 'proposals')) LOOP
    PERFORM gov._mark(p_run,
      CASE WHEN p.status <> 'accepted' THEN 'a memory imported from ' || gov._source_name(p.source) || ' that '
                                            || gov._person_name(p.person_id) || ' never accepted' END,
      gov._person_name(p.person_id) || '’s memory');
  END LOOP;
END
$$;
