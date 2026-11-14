-- Explicit project/directory/automation authority; never inferred from a renderer's identity.
CREATE FUNCTION gov.identity_directory_update(p_issuer text, p_person uuid, p_name text, p_active boolean, p_revision bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE me uuid; d record; status text; ws uuid:=sec.current_workspace();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('identity:'||ws::text,17)); PERFORM gov._lock_workspace(); me:=gov._admin();
  SELECT * INTO d FROM app.identity_directory WHERE workspace_id=ws AND principal_id=p_person AND issuer=p_issuer FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found: no directory person'; END IF;
  IF d.revision<>p_revision THEN RAISE EXCEPTION 'stale: directory changed'; END IF;
  SELECT p.status INTO status FROM app.principals p WHERE p.workspace_id=ws AND p.id=p_person;
  IF status='removed' AND p_active THEN RAISE EXCEPTION 'revoked: removed access stays removed'; END IF;
  IF NOT p_active THEN PERFORM gov.identity_remove(p_person); END IF;
  UPDATE app.identity_directory SET display_name=p_name,revision=revision+1 WHERE workspace_id=ws AND principal_id=p_person;
  IF status='active' THEN UPDATE app.principals SET name=coalesce(nullif(p_name,''),d.user_name) WHERE workspace_id=ws AND id=p_person; END IF;
  PERFORM gov._append('identity.directory_changed',p_person::text,jsonb_build_object('active',p_active));
  RETURN p_person;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_directory_update(text,uuid,text,boolean,bigint) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_directory_update(text,uuid,text,boolean,bigint) TO backbone_app;
