-- What a new run starts holding: its routine's instruction, when the routine's task is private; the
-- words people wrote in a private conversation; and whatever its task's earlier work read.
CREATE FUNCTION gov._initial_marks(p_run uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  r record;
  t record;
  ro record;
BEGIN
  SELECT * INTO r FROM app.runs x WHERE x.workspace_id = ws AND x.id = p_run;
  SELECT * INTO t FROM app.tasks x WHERE x.workspace_id = ws AND x.id = r.task_id;
  IF t.visibility = 'private' THEN
    SELECT * INTO ro FROM app.routines x WHERE x.workspace_id = ws AND x.task_id = t.id;
    IF FOUND AND ro.kind = 'instruction' AND ro.instruction IS NOT NULL THEN
      PERFORM gov._mark(p_run, NULL, 'the instruction ' || gov._person_name(ro.person_id) || ' gave this routine');
    END IF;
    IF EXISTS (SELECT FROM app.messages m WHERE m.workspace_id = ws AND m.task_id = t.id AND m.role = 'person') THEN
      PERFORM gov._mark(p_run, NULL, 'what people wrote in this private conversation');
    END IF;
  END IF;
  PERFORM gov._carry_task_marks(p_run);
END
$$;
