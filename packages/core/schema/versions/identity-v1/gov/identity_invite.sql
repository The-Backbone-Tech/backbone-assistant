-- Identity operations serialize admission and revocation before observing authority.
CREATE FUNCTION gov.identity_invite(p_hash text, p_role text, p_expires timestamptz) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE me uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('identity:'||sec.current_workspace()::text,17));
  PERFORM gov._lock_workspace(); me := gov._admin();
  IF p_hash !~ '^[a-f0-9]{64}$' OR p_role NOT IN ('admin','member','guest') OR p_expires <= clock_timestamp() OR p_expires > clock_timestamp()+interval '7 days' THEN
    RAISE EXCEPTION 'invalid: invitation role, token or expiry';
  END IF;
  INSERT INTO app.identity_invitations(workspace_id,token_hash,role,invited_by,expires_at)
  VALUES(sec.current_workspace(),p_hash,p_role,me,p_expires);
  PERFORM gov._append('identity.invited',p_hash,jsonb_build_object('role',p_role));
  RETURN p_hash;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_invite(text,text,timestamptz) FROM PUBLIC, backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_invite(text,text,timestamptz) TO backbone_app;

