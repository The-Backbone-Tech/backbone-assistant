-- Explicit project/directory/automation authority; never inferred from a renderer's identity.
CREATE FUNCTION gov.identity_automation_create(p_person uuid, p_project uuid, p_name text, p_piece uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE me uuid; agent uuid; mandate uuid; ws uuid:=sec.current_workspace();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('identity:'||ws::text,17)); PERFORM gov._lock_workspace(); me:=gov._admin();
  IF coalesce(gov.identity_project_access(p_project),'') NOT IN ('owner','editor') THEN RAISE EXCEPTION 'denied: project unavailable'; END IF;
  IF sec.role_of(p_person) IS NULL OR sec.role_of(p_person)='guest' OR nullif(btrim(p_name),'') IS NULL THEN RAISE EXCEPTION 'role: automation needs a named active person who may work'; END IF;
  PERFORM set_config('backbone.principal',p_person::text,true);
  IF coalesce(gov.identity_project_access(p_project),'') NOT IN ('owner','editor') THEN RAISE EXCEPTION 'denied: the named person cannot work in this project'; END IF;
  agent:=gov.create_agent(p_name,'worker');
  mandate:=gov.issue_mandate(agent,NULL,jsonb_build_array(p_project::text),'"*"','"*"','"*"',3::smallint,NULL,NULL,NULL,NULL,clock_timestamp()+interval '1 year',CASE WHEN p_piece IS NULL THEN 'direct' ELSE 'piece' END,jsonb_build_object('identityAutomation',true,'project',p_project,'createdBy',me),p_piece);
  PERFORM set_config('backbone.principal',me::text,true);
  PERFORM gov._append('identity.automation_created',agent::text,jsonb_build_object('person',p_person,'project',p_project,'mandate',mandate),me);
  RETURN agent;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_automation_create(uuid,uuid,text,uuid) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_automation_create(uuid,uuid,text,uuid) TO backbone_app;
