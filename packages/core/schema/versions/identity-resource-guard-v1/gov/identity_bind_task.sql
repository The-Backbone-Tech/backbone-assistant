-- Bind an existing private task only by its own requester in an owned project.
CREATE OR REPLACE FUNCTION gov.identity_bind_task(p_project uuid,p_task uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE me uuid;
BEGIN
  PERFORM gov._lock_workspace(); me:=gov._person();
  IF coalesce(gov.identity_project_access(p_project),'')<>'owner' OR NOT EXISTS(SELECT FROM app.tasks WHERE workspace_id=sec.current_workspace() AND id=p_task AND requested_by=me) THEN RAISE EXCEPTION 'denied: task binding belongs to its requester'; END IF;
  INSERT INTO app.identity_task_projects(workspace_id,task_id,project_id) VALUES(sec.current_workspace(),p_task,p_project) ON CONFLICT(workspace_id,task_id) DO UPDATE SET project_id=EXCLUDED.project_id
  WHERE app.identity_task_projects.project_id=p_task;
  DELETE FROM app.identity_project_people WHERE workspace_id=sec.current_workspace() AND project_id=p_task AND p_task<>p_project AND NOT EXISTS(SELECT FROM app.identity_task_projects WHERE workspace_id=sec.current_workspace() AND project_id=p_task);
  DELETE FROM app.identity_workspace_projects WHERE workspace_id=sec.current_workspace() AND project_id=p_task AND p_task<>p_project AND NOT EXISTS(SELECT FROM app.identity_task_projects WHERE workspace_id=sec.current_workspace() AND project_id=p_task);
  DELETE FROM app.identity_projects WHERE workspace_id=sec.current_workspace() AND project_id=p_task AND p_task<>p_project AND NOT EXISTS(SELECT FROM app.identity_task_projects WHERE workspace_id=sec.current_workspace() AND project_id=p_task);
  RETURN p_task;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_bind_task(uuid,uuid) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_bind_task(uuid,uuid) TO backbone_app;
