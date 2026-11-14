-- Explicit project/directory/automation authority; never inferred from a renderer's identity.
CREATE FUNCTION gov.identity_create_task(p_project uuid, p_title text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE me uuid; task uuid;
BEGIN
  PERFORM gov._lock_workspace(); me:=gov._person();
  IF gov.identity_project_access(p_project) NOT IN ('owner','editor') OR gov.identity_project_access(p_project) IS NULL THEN RAISE EXCEPTION 'denied: project is read only or unavailable'; END IF;
  task:=gov.create_task(me,me,p_title,NULL,NULL);
  INSERT INTO app.identity_task_projects(workspace_id,task_id,project_id) VALUES(sec.current_workspace(),task,p_project);
  INSERT INTO app.task_people(workspace_id,task_id,person_id)
  SELECT sec.current_workspace(),task,p.owner_id FROM app.identity_projects p WHERE p.workspace_id=sec.current_workspace() AND p.project_id=p_project AND p.owner_id<>me
  UNION SELECT sec.current_workspace(),task,a.person_id FROM app.identity_project_people a WHERE a.workspace_id=sec.current_workspace() AND a.project_id=p_project AND a.person_id<>me
  ON CONFLICT(workspace_id,task_id,person_id) DO NOTHING;
  RETURN task;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_create_task(uuid,text) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_create_task(uuid,text) TO backbone_app;
