-- Identity operations serialize admission and revocation before observing authority.
CREATE FUNCTION gov.identity_accept(p_hash text, p_issuer text, p_subject text, p_name text, p_session text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE inv record; person uuid := gen_random_uuid(); ws uuid := sec.current_workspace();
BEGIN
  IF sec.current_principal() IS NOT NULL OR sec.names_run() THEN RAISE EXCEPTION 'empty_session_only: accept without a principal'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('identity:'||ws::text,17));
  PERFORM gov._lock_workspace();
  SELECT * INTO inv FROM app.identity_invitations WHERE workspace_id=ws AND token_hash=p_hash AND accepted_by IS NULL AND expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND OR NOT sec.is_admin(inv.invited_by) THEN RAISE EXCEPTION 'invitation: unavailable invitation'; END IF;
  IF nullif(p_issuer,'') IS NULL OR nullif(p_subject,'') IS NULL OR nullif(btrim(p_name),'') IS NULL OR p_session !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid: identity binding'; END IF;
  INSERT INTO app.principals(workspace_id,id,kind,role,name,user_id) VALUES(ws,person,'person',inv.role,p_name,person::text);
  INSERT INTO app.identity_accounts(workspace_id,principal_id,issuer,subject) VALUES(ws,person,p_issuer,p_subject);
  INSERT INTO app.identity_sessions(workspace_id,token_hash,principal_id,expires_at) VALUES(ws,p_session,person,clock_timestamp()+interval '12 hours');
  UPDATE app.identity_invitations SET accepted_by=person WHERE workspace_id=ws AND token_hash=p_hash;
  PERFORM gov._append('identity.accepted',person::text,jsonb_build_object('role',inv.role,'invited_by',inv.invited_by),person);
  RETURN person;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_accept(text,text,text,text,text) FROM PUBLIC, backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_accept(text,text,text,text,text) TO backbone_app;

