-- Identity operations serialize admission and revocation before observing authority.
CREATE FUNCTION gov.identity_project_access(p_project uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE me uuid:=sec.current_principal(); access text;
BEGIN
  IF me IS NULL OR sec.principal_kind(me)<>'person' THEN RETURN NULL; END IF;
  SELECT CASE WHEN p.owner_id=me THEN 'owner' ELSE a.access END INTO access
  FROM app.identity_projects p LEFT JOIN app.identity_project_people a ON a.workspace_id=p.workspace_id AND a.project_id=p.project_id AND a.person_id=me
  WHERE p.workspace_id=sec.current_workspace() AND p.project_id=p_project;
  IF sec.role_of(me)='guest' AND access IN ('owner','editor') THEN RETURN 'viewer'; END IF;
  RETURN access;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_project_access(uuid) FROM PUBLIC, backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_project_access(uuid) TO backbone_app;

