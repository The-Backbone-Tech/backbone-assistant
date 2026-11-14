-- Restrictive project checks retain legacy crossings and the run-secret accounting exception.
CREATE FUNCTION gov.identity_document_access(p_document uuid,p_write boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE task uuid;
BEGIN
  SELECT task_id INTO task FROM app.documents WHERE workspace_id=sec.current_workspace() AND id=p_document;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN gov.identity_task_access(task,p_write);
END
$$;
REVOKE ALL ON FUNCTION gov.identity_document_access(uuid,boolean) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_document_access(uuid,boolean) TO backbone_app,backbone_owner;
