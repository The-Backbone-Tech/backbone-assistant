-- Whether the session's viewer may see a task: one shared with the workspace, one the viewer asked
-- for or is its beneficiary or has joined, or any task to the system principal.
CREATE FUNCTION sec.task_visible(p_task uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT FROM app.tasks t
    WHERE t.workspace_id = sec.current_workspace() AND t.id = p_task
      AND (t.visibility = 'workspace'
           OR sec.viewer() IN (t.requested_by, t.on_behalf_of)
           OR sec.viewer() = sec.system_principal()
           OR EXISTS (SELECT FROM app.task_people tp
                      WHERE tp.workspace_id = t.workspace_id AND tp.task_id = t.id AND tp.person_id = sec.viewer())))
$$;
