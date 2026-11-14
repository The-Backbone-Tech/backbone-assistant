-- Whether a given person may see a task: shared with the workspace, asked for by them, for them,
-- or joined by them.
CREATE FUNCTION sec.task_visible_to(p_task uuid, p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT FROM app.tasks t
    WHERE t.workspace_id = sec.current_workspace() AND t.id = p_task
      AND (t.visibility = 'workspace' OR p_person IN (t.requested_by, t.on_behalf_of)
           OR EXISTS (SELECT FROM app.task_people tp WHERE tp.workspace_id = t.workspace_id AND tp.task_id = t.id AND tp.person_id = p_person)))
$$;
