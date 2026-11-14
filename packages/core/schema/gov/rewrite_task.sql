-- Change a task's title, goal or status. Its people change its words; a run of the task changes
-- only its status, never its title or goal. A task the session cannot see is not changed (0).
CREATE FUNCTION gov.rewrite_task(p_task uuid, p_title text, p_goal text, p_status text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := sec.current_principal();
  t record;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no_identity: the session acts as nobody';
  END IF;
  SELECT * INTO t FROM app.tasks WHERE workspace_id = ws AND id = p_task;
  IF NOT FOUND OR NOT sec.task_visible(p_task) THEN
    RETURN 0;
  END IF;
  IF sec.names_run() THEN
    IF p_title IS NOT NULL OR p_goal IS NOT NULL THEN
      RAISE EXCEPTION 'not_by_runs: a run never rewrites its task''s title or goal';
    END IF;
    IF NOT EXISTS (SELECT FROM app.runs WHERE workspace_id = ws AND id = sec.current_run() AND task_id = p_task) THEN
      RETURN 0;
    END IF;
  ELSIF sec.principal_kind(me) <> 'person' THEN
    RAISE EXCEPTION 'role: only a task''s people change it';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'waiting', 'done', 'cancelled') THEN
    RAISE EXCEPTION 'invalid: no such task status';
  END IF;
  UPDATE app.tasks SET title = coalesce(p_title, title), goal = coalesce(p_goal, goal), status = coalesce(p_status, status)
  WHERE workspace_id = ws AND id = p_task;
  PERFORM gov._append('task.changed', p_task::text, jsonb_build_object(
    'title', CASE WHEN p_title IS NOT NULL THEN sec.digest(p_title) END,
    'goal', CASE WHEN p_goal IS NOT NULL THEN sec.digest(p_goal) END, 'status', p_status));
  RETURN 1;
END
$$;
