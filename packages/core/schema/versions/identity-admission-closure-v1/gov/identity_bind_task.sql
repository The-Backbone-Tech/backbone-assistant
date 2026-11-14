-- Bind an existing task only by its requester, with write access to both projects.
CREATE OR REPLACE FUNCTION gov.identity_bind_task(p_project uuid,p_task uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE me uuid; prior_project uuid;
BEGIN
  PERFORM gov._lock_workspace(); me:=gov._person();
  IF coalesce(gov.identity_project_access(p_project),'') NOT IN('owner','editor') OR NOT EXISTS(SELECT FROM app.tasks WHERE workspace_id=sec.current_workspace() AND id=p_task AND requested_by=me) THEN RAISE EXCEPTION 'denied: task binding belongs to its requester'; END IF;
  SELECT project_id INTO prior_project FROM app.identity_task_projects WHERE workspace_id=sec.current_workspace() AND task_id=p_task;
  IF EXISTS(SELECT FROM app.identity_task_projects x WHERE x.workspace_id=sec.current_workspace() AND x.task_id=p_task
    AND coalesce(gov.identity_project_access(x.project_id),'') NOT IN('owner','editor')) THEN RAISE EXCEPTION 'denied: current project is not writable'; END IF;
  INSERT INTO app.identity_task_projects(workspace_id,task_id,project_id) VALUES(sec.current_workspace(),p_task,p_project)
    ON CONFLICT(workspace_id,task_id) DO UPDATE SET project_id=EXCLUDED.project_id;
  -- Audience history is append-only. Destination readers participate in every
  -- publication decision even if the task was private before this binding.
  INSERT INTO app.task_people(workspace_id,task_id,person_id)
  SELECT sec.current_workspace(),p_task,p.owner_id FROM app.identity_projects p WHERE p.workspace_id=sec.current_workspace() AND p.project_id=p_project AND p.owner_id<>me
  UNION SELECT sec.current_workspace(),p_task,a.person_id FROM app.identity_project_people a WHERE a.workspace_id=sec.current_workspace() AND a.project_id=p_project AND a.person_id<>me
  ON CONFLICT(workspace_id,task_id,person_id) DO NOTHING;
  DELETE FROM app.identity_project_people WHERE workspace_id=sec.current_workspace() AND project_id=p_task AND prior_project=p_task AND p_task<>p_project AND NOT EXISTS(SELECT FROM app.identity_task_projects WHERE workspace_id=sec.current_workspace() AND project_id=p_task);
  DELETE FROM app.identity_workspace_projects WHERE workspace_id=sec.current_workspace() AND project_id=p_task AND prior_project=p_task AND p_task<>p_project AND NOT EXISTS(SELECT FROM app.identity_task_projects WHERE workspace_id=sec.current_workspace() AND project_id=p_task);
  DELETE FROM app.identity_projects WHERE workspace_id=sec.current_workspace() AND project_id=p_task AND prior_project=p_task AND p_task<>p_project AND NOT EXISTS(SELECT FROM app.identity_task_projects WHERE workspace_id=sec.current_workspace() AND project_id=p_task);
  RETURN p_task;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_bind_task(uuid,uuid) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_bind_task(uuid,uuid) TO backbone_app;
