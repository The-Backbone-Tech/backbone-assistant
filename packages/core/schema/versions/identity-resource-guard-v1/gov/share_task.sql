-- Share a task with the whole workspace: its requester, its beneficiary or an admin who sees it.
CREATE OR REPLACE FUNCTION gov.share_task(p_task uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := gov._person();
  t record;
BEGIN
  SELECT * INTO t FROM app.tasks WHERE workspace_id = sec.current_workspace() AND id = p_task;
  IF NOT FOUND OR NOT sec.task_visible(p_task) THEN
    RAISE EXCEPTION 'not_found: no such task for this person';
  END IF;
  IF me NOT IN (t.requested_by, t.on_behalf_of) AND NOT sec.is_admin(me) THEN
    RAISE EXCEPTION 'role: a task is shared by its people or an admin';
  END IF;
  IF NOT EXISTS(SELECT FROM app.identity_task_projects WHERE workspace_id=t.workspace_id AND task_id=p_task AND project_id=p_task) THEN RAISE EXCEPTION 'denied: use the project sharing boundary for a project task'; END IF;
  INSERT INTO app.identity_workspace_projects(workspace_id,project_id) VALUES(t.workspace_id,p_task) ON CONFLICT DO NOTHING;
  UPDATE app.tasks SET visibility = 'workspace' WHERE workspace_id = t.workspace_id AND id = p_task;
  PERFORM gov._append('task.shared', p_task::text, '{}');
  RETURN p_task;
END
$$;
