-- Only the device's trusted operator connection reaches this crossing. The Host
-- binds its arguments to core.json; no session or transport supplies a target.
CREATE FUNCTION operator.identity_restore_device_access(p_person uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE ws uuid:=sec.current_workspace(); target record;
BEGIN
  IF session_user<>'backbone_operator' OR sec.current_run() IS NOT NULL THEN
    RAISE EXCEPTION 'denied: device operator only';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('identity:'||ws::text,17));
  PERFORM gov._lock_workspace();
  SELECT * INTO target FROM app.principals WHERE workspace_id=ws AND id=p_person AND kind='person' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found: no device person'; END IF;
  UPDATE app.principals SET status='active',role='owner' WHERE workspace_id=ws AND id=p_person;
  PERFORM set_config('backbone.principal',p_person::text,true);
  -- Recovery does not renew a session, agent, automation or revoked permission.
  PERFORM gov._append('identity.device_access_restored',p_person::text,
    jsonb_build_object('from_status',target.status,'from_role',target.role,'path','device'),p_person);
  RETURN p_person;
END
$$;
REVOKE ALL ON FUNCTION operator.identity_restore_device_access(uuid) FROM PUBLIC, backbone_app;
GRANT EXECUTE ON FUNCTION operator.identity_restore_device_access(uuid) TO backbone_operator;
