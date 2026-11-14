-- Explicit project/directory/automation authority; never inferred from a renderer's identity.
CREATE FUNCTION gov.identity_document_version(p_project uuid, p_document uuid) RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE version integer;
BEGIN
  IF gov.identity_project_access(p_project) IS NULL THEN RAISE EXCEPTION 'denied: project unavailable'; END IF;
  SELECT d.version INTO version FROM app.documents d JOIN app.identity_task_projects t ON t.workspace_id=d.workspace_id AND t.task_id=d.task_id
  WHERE d.workspace_id=sec.current_workspace() AND d.id=p_document AND t.project_id=p_project;
  RETURN version;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_document_version(uuid,uuid) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_document_version(uuid,uuid) TO backbone_app;
