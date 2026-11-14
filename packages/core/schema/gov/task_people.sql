-- Who a task is for, in the crossings' own sentence, for a session that may see the task.
CREATE FUNCTION gov.task_people(p_task uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  t record;
BEGIN
  SELECT * INTO t FROM app.tasks x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_task;
  IF NOT FOUND OR NOT sec.task_visible(p_task) THEN
    RAISE EXCEPTION 'denied: who a task is for is told only to those who see it';
  END IF;
  RETURN CASE WHEN t.visibility = 'workspace' THEN 'everyone in the workspace' ELSE gov._person_name(t.on_behalf_of) END;
END
$$;
