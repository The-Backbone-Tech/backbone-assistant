-- Identity operations serialize admission and revocation before observing authority.
CREATE FUNCTION gov.identity_project_create(p_project uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE me uuid;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('identity:'||sec.current_workspace()::text,17));
  PERFORM gov._lock_workspace(); me:=gov._person();
  IF sec.role_of(me)='guest' THEN RAISE EXCEPTION 'role: guests do not create projects'; END IF;
  INSERT INTO app.identity_projects(workspace_id,project_id,owner_id) VALUES(sec.current_workspace(),p_project,me);
  PERFORM gov._append('identity.project_created',p_project::text,'{}');
  RETURN p_project;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_project_create(uuid) FROM PUBLIC, backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_project_create(uuid) TO backbone_app;

