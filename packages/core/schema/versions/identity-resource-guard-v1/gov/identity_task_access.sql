-- Temporary installer lookup for the table owner; revoked after the attachments.
GRANT USAGE ON SCHEMA gov TO backbone_owner;
-- Restrictive project checks retain legacy crossings and the run-secret accounting exception.
CREATE OR REPLACE FUNCTION gov.identity_task_access(p_task uuid,p_write boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE project uuid; viewer uuid; principal uuid;
BEGIN
  principal:=sec.current_principal();
  IF principal=sec.system_principal() THEN RETURN true; END IF;
  IF p_task IS NULL OR principal IS NULL THEN RETURN false; END IF;
  SELECT project_id INTO project FROM app.identity_task_projects WHERE workspace_id=sec.current_workspace() AND task_id=p_task;
  IF NOT FOUND THEN RETURN false; END IF;
  viewer:=sec.viewer();
  RETURN gov.identity_person_task_access(p_task,viewer,p_write);
END
$$;
REVOKE ALL ON FUNCTION gov.identity_task_access(uuid,boolean) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_task_access(uuid,boolean) TO backbone_app,backbone_owner;
