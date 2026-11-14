-- Identity operations serialize admission and revocation before observing authority.
CREATE OR REPLACE FUNCTION gov.identity_project_share(p_project uuid, p_person uuid, p_access text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE ws uuid:=sec.current_workspace(); me uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('identity:'||ws::text,17));
  PERFORM gov._lock_workspace(); me:=gov._person();
  IF NOT EXISTS(SELECT FROM app.identity_projects WHERE workspace_id=ws AND project_id=p_project AND owner_id=me) THEN RAISE EXCEPTION 'denied: only the project owner shares it'; END IF;
  IF p_access IS NOT NULL AND p_access NOT IN ('viewer','editor') THEN RAISE EXCEPTION 'invalid: project access'; END IF;
  IF sec.role_of(p_person) IS NULL THEN RAISE EXCEPTION 'not_found: no active person'; END IF;
  IF p_person=me THEN RAISE EXCEPTION 'invalid: the project owner keeps ownership'; END IF;
  IF sec.role_of(p_person)='guest' AND p_access='editor' THEN RAISE EXCEPTION 'role: guests only view'; END IF;
  IF p_access IS NULL THEN DELETE FROM app.identity_project_people WHERE workspace_id=ws AND project_id=p_project AND person_id=p_person;
  ELSE INSERT INTO app.identity_project_people(workspace_id,project_id,person_id,access) VALUES(ws,p_project,p_person,p_access)
    ON CONFLICT(workspace_id,project_id,person_id) DO UPDATE SET access=EXCLUDED.access;
  END IF;
  -- Audience history is retained. Revoking a project grant does not make words
  -- already shared private again; restrictive policies enforce current access.
  IF p_access IS NOT NULL THEN
    INSERT INTO app.task_people(workspace_id,task_id,person_id)
    SELECT ws,t.task_id,p_person FROM app.identity_task_projects t WHERE t.workspace_id=ws AND t.project_id=p_project
    ON CONFLICT(workspace_id,task_id,person_id) DO NOTHING;
  END IF;
  PERFORM gov._append('identity.project_shared',p_project::text,jsonb_build_object('person',p_person,'access',p_access));
  RETURN p_project;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_project_share(uuid,uuid,text) FROM PUBLIC, backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_project_share(uuid,uuid,text) TO backbone_app;
