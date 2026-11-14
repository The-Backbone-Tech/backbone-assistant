-- A directory deletion is terminal, issuer-scoped and atomic with access revocation.
CREATE FUNCTION gov.identity_directory_delete(p_issuer text,p_person uuid,p_revision bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE d record; ws uuid:=sec.current_workspace(); me uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('identity:'||ws::text,17)); PERFORM gov._lock_workspace(); me:=gov._admin();
  SELECT * INTO d FROM app.identity_directory WHERE workspace_id=ws AND principal_id=p_person AND issuer=p_issuer FOR UPDATE;
  IF NOT FOUND OR EXISTS(SELECT FROM app.identity_directory_deleted WHERE workspace_id=ws AND principal_id=p_person) THEN RETURN NULL; END IF;
  IF d.revision<>p_revision THEN RAISE EXCEPTION 'stale: directory changed'; END IF;
  PERFORM gov.identity_remove(p_person);
  INSERT INTO app.identity_directory_deleted(workspace_id,principal_id) VALUES(ws,p_person);
  PERFORM gov._append('identity.directory_deleted',p_person::text,jsonb_build_object('by',me));
  RETURN p_person;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_directory_delete(text,uuid,bigint) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_directory_delete(text,uuid,bigint) TO backbone_app;
