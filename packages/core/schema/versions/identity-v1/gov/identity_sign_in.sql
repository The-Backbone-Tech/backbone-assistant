-- Identity operations serialize admission and revocation before observing authority.
CREATE FUNCTION gov.identity_sign_in(p_issuer text, p_subject text, p_session text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE person uuid; ws uuid := sec.current_workspace();
BEGIN
  IF sec.current_principal() IS NOT NULL OR sec.names_run() THEN RAISE EXCEPTION 'empty_session_only: sign in without a principal'; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('identity:'||ws::text,17));
  SELECT a.principal_id INTO person FROM app.identity_accounts a JOIN app.principals p ON p.workspace_id=a.workspace_id AND p.id=a.principal_id
  WHERE a.workspace_id=ws AND a.issuer=p_issuer AND a.subject=p_subject AND p.status='active';
  IF person IS NULL THEN RAISE EXCEPTION 'no_identity: account has no live membership'; END IF;
  IF p_session !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid: session token'; END IF;
  INSERT INTO app.identity_sessions(workspace_id,token_hash,principal_id,expires_at) VALUES(ws,p_session,person,clock_timestamp()+interval '12 hours');
  PERFORM gov._append('identity.signed_in',person::text,'{}',person);
  RETURN person;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_sign_in(text,text,text) FROM PUBLIC, backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_sign_in(text,text,text) TO backbone_app;

