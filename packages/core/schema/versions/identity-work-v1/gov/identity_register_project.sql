-- Explicit project/directory/automation authority; never inferred from a renderer's identity.
CREATE FUNCTION gov.identity_register_project(p_project uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  PERFORM gov._person();
  IF EXISTS(SELECT FROM app.identity_projects WHERE workspace_id=sec.current_workspace() AND project_id=p_project) THEN RETURN p_project; END IF;
  RETURN gov.identity_project_create(p_project);
END
$$;
REVOKE ALL ON FUNCTION gov.identity_register_project(uuid) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_register_project(uuid) TO backbone_app;
