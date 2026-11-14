-- Its person fires a routine by hand: one run in the routine's task, under its mandate.
CREATE FUNCTION gov.run_routine_now(p_routine uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := gov._person('not_by_runs');
  ro record;
BEGIN
  SELECT * INTO ro FROM app.routines x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_routine;
  IF NOT FOUND OR ro.person_id <> me THEN
    RAISE EXCEPTION 'not_found: no such routine of this person';
  END IF;
  RETURN gov.queue_run(ro.task_id, ro.agent_id, ro.mandate_id, ro.id);
END
$$;
