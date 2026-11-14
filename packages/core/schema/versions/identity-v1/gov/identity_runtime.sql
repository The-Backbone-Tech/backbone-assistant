-- Identity operations serialize admission and revocation before observing authority.
CREATE FUNCTION gov.identity_runtime(p_piece uuid) RETURNS TABLE(agent uuid, mandate uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE me uuid; prior record; key text:=coalesce(p_piece::text,'direct'); a uuid; m uuid; ws uuid:=sec.current_workspace();
BEGIN
  PERFORM gov._lock_workspace(); me:=gov._person();
  IF sec.role_of(me)='guest' THEN RAISE EXCEPTION 'role: guests run no automation'; END IF;
  SELECT * INTO prior FROM app.identity_agents WHERE workspace_id=ws AND person_id=me AND carrier=key;
  IF FOUND THEN
    IF NOT EXISTS(SELECT FROM app.mandates WHERE workspace_id=ws AND id=prior.mandate_id AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'revoked: automation is closed'; END IF;
    RETURN QUERY SELECT prior.agent_id,prior.mandate_id; RETURN;
  END IF;
  a:=gov.create_agent('Work for '||(SELECT name FROM app.principals WHERE workspace_id=ws AND id=me),'worker');
  m:=gov.issue_mandate(a,NULL,'"*"','"*"','"*"','"*"',3::smallint,NULL,NULL,NULL,NULL,clock_timestamp()+interval '1 year',CASE WHEN p_piece IS NULL THEN 'direct' ELSE 'piece' END,'{}',p_piece);
  INSERT INTO app.identity_agents(workspace_id,person_id,carrier,agent_id,mandate_id) VALUES(ws,me,key,a,m);
  RETURN QUERY SELECT a,m;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_runtime(uuid) FROM PUBLIC, backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_runtime(uuid) TO backbone_app;

