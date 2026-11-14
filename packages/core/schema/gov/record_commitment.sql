-- The run, while it acts, records a promise in its task. Work that kept its work records no promise
-- another person would read.
CREATE FUNCTION gov.record_commitment(p_task uuid, p_agent uuid, p_to uuid, p_text text, p_due date, p_priority smallint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  run uuid := sec.current_run();
  new_id uuid := gen_random_uuid();
BEGIN
  IF run IS NULL OR NOT EXISTS (SELECT FROM app.runs r WHERE r.workspace_id = ws AND r.id = run AND r.task_id = p_task AND r.agent_id = p_agent) THEN
    RAISE EXCEPTION 'not_in_run: a promise is recorded by the run that acts, in its own task';
  END IF;
  IF p_text IS NULL OR length(p_text) = 0 THEN
    RAISE EXCEPTION 'invalid: a promise says what is promised';
  END IF;
  IF gov._run_kept(run) AND ((p_to IS NOT NULL AND p_to <> gov._run_person(run)) OR gov._task_read_beyond(p_task, gov._run_person(run))) THEN
    RAISE EXCEPTION 'denied: work that kept its work records no promise others would read';
  END IF;
  INSERT INTO app.commitments (workspace_id, id, task_id, run_id, agent_id, to_person, text, due, priority)
  VALUES (ws, new_id, p_task, run, p_agent, p_to, p_text, p_due, coalesce(p_priority, 3));
  PERFORM gov._append('commitment.recorded', new_id::text, jsonb_build_object('task', p_task, 'run', run, 'to', p_to, 'text', sec.digest(p_text)));
  RETURN new_id;
END
$$;
