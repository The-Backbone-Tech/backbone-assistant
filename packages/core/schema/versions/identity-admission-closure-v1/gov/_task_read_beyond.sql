-- Whether a task is read by anyone but one person: shared with the workspace, joined by others, or
-- bound to a group channel thread.
CREATE OR REPLACE FUNCTION gov._task_read_beyond(p_task uuid, p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT FROM app.tasks t WHERE t.workspace_id = sec.current_workspace() AND t.id = p_task
      AND (t.visibility = 'workspace' OR p_person NOT IN (t.requested_by, t.on_behalf_of)
           OR EXISTS (SELECT FROM app.task_people tp WHERE tp.workspace_id = t.workspace_id AND tp.task_id = t.id AND tp.person_id <> p_person)
           OR EXISTS (SELECT FROM app.identity_task_projects b JOIN app.identity_projects p ON p.workspace_id=b.workspace_id AND p.project_id=b.project_id
             WHERE b.workspace_id=t.workspace_id AND b.task_id=t.id AND (p.owner_id<>p_person
               OR EXISTS(SELECT FROM app.identity_project_people a WHERE a.workspace_id=b.workspace_id AND a.project_id=b.project_id AND a.person_id<>p_person)
               OR EXISTS(SELECT FROM app.identity_workspace_projects w WHERE w.workspace_id=b.workspace_id AND w.project_id=b.project_id)))
           OR EXISTS (SELECT FROM app.channel_threads ct WHERE ct.workspace_id = t.workspace_id AND ct.task_id = t.id AND ct.kind = 'group')))
$$;
