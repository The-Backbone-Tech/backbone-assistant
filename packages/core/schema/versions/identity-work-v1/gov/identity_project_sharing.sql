-- Only the project owner inspects its grants. Seeing the project is not authority to share it.
CREATE FUNCTION gov.identity_project_sharing(p_project uuid) RETURNS TABLE(person uuid,access text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
BEGIN
  IF coalesce(gov.identity_project_access(p_project),'')<>'owner' THEN RAISE EXCEPTION 'denied: project ownership required'; END IF;
  RETURN QUERY SELECT a.person_id,a.access FROM app.identity_project_people a WHERE a.workspace_id=sec.current_workspace() AND a.project_id=p_project ORDER BY a.person_id;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_project_sharing(uuid) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_project_sharing(uuid) TO backbone_app;
