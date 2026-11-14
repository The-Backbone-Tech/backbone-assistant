-- A version inherits the document's actual project or explicit workspace scope.
REVOKE USAGE ON SCHEMA gov FROM backbone_owner;
CREATE OR REPLACE FUNCTION gov.identity_document_access(p_document uuid,p_write boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE task uuid;
BEGIN
  SELECT task_id INTO task FROM app.documents WHERE workspace_id=sec.current_workspace() AND id=p_document;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN gov.identity_material_scope(task,p_write);
END
$$;
