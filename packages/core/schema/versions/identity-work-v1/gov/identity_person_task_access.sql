-- Installer-only schema lookup permits the table owner to bind policies to these OIDs.
GRANT USAGE ON SCHEMA gov TO backbone_owner;
-- Current project access is separate from immutable records of everyone who saw its words.
CREATE FUNCTION gov.identity_person_task_access(p_task uuid,p_person uuid,p_write boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE project uuid; permission text; role text;
BEGIN
  SELECT project_id INTO project FROM app.identity_task_projects WHERE workspace_id=sec.current_workspace() AND task_id=p_task;
  IF NOT FOUND THEN RETURN true; END IF;
  role:=sec.role_of(p_person);
  IF role IS NULL THEN RETURN false; END IF;
  SELECT CASE WHEN p.owner_id=p_person THEN 'owner' ELSE a.access END INTO permission
  FROM app.identity_projects p LEFT JOIN app.identity_project_people a ON a.workspace_id=p.workspace_id AND a.project_id=p.project_id AND a.person_id=p_person
  WHERE p.workspace_id=sec.current_workspace() AND p.project_id=project;
  RETURN coalesce(permission='owner' OR (permission='editor' AND role<>'guest') OR (NOT p_write AND permission IS NOT NULL),false);
END
$$;
REVOKE ALL ON FUNCTION gov.identity_person_task_access(uuid,uuid,boolean) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_person_task_access(uuid,uuid,boolean) TO backbone_app,backbone_owner;
