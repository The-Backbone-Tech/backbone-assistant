-- Restrictive project checks retain legacy crossings and the run-secret accounting exception.
CREATE FUNCTION gov.identity_task_access(p_task uuid,p_write boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE project uuid; viewer uuid; principal uuid;
BEGIN
  IF p_task IS NULL THEN RETURN true; END IF;
  SELECT project_id INTO project FROM app.identity_task_projects WHERE workspace_id=sec.current_workspace() AND task_id=p_task;
  IF NOT FOUND THEN RETURN true; END IF;
  principal:=sec.current_principal();
  IF principal=sec.system_principal() THEN RETURN true; END IF;
  IF principal IS NULL AND NOT sec.names_run() AND coalesce(current_setting('backbone.principal',true),'')='' THEN RETURN true; END IF;
  viewer:=sec.viewer();
  RETURN gov.identity_person_task_access(p_task,viewer,p_write);
END
$$;
REVOKE ALL ON FUNCTION gov.identity_task_access(uuid,boolean) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_task_access(uuid,boolean) TO backbone_app,backbone_owner;
