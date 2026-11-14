-- Explicit project/directory/automation authority; never inferred from a renderer's identity.
CREATE FUNCTION gov.identity_revise_document(p_project uuid, p_document uuid, p_content text, p_base integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE me uuid; version integer; ws uuid:=sec.current_workspace();
BEGIN
  PERFORM gov._lock_workspace(); me:=gov._person();
  IF coalesce(gov.identity_project_access(p_project),'') NOT IN ('owner','editor') THEN RAISE EXCEPTION 'denied: project is read only'; END IF;
  SELECT d.version INTO version FROM app.documents d JOIN app.identity_task_projects t ON t.workspace_id=d.workspace_id AND t.task_id=d.task_id
  WHERE d.workspace_id=ws AND d.id=p_document AND t.project_id=p_project FOR UPDATE OF d;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found: no document in this project'; END IF;
  IF version<>p_base THEN RAISE EXCEPTION 'stale: document changed'; END IF;
  UPDATE app.documents SET content=p_content,updated_by=me,content_author=me,via_effect=NULL WHERE workspace_id=ws AND id=p_document;
  SELECT d.version INTO version FROM app.documents d WHERE d.workspace_id=ws AND d.id=p_document;
  PERFORM gov._append('document.revised',p_document::text,jsonb_build_object('version',version));
  RETURN version;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_revise_document(uuid,uuid,text,integer) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_revise_document(uuid,uuid,text,integer) TO backbone_app;
