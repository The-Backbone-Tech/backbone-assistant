-- Identity operations serialize admission and revocation before observing authority.
CREATE FUNCTION gov.identity_session(p_hash text) RETURNS TABLE(principal uuid, name text, role text, expires_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY SELECT p.id,p.name,p.role,s.expires_at FROM app.identity_sessions s JOIN app.principals p ON p.workspace_id=s.workspace_id AND p.id=s.principal_id
  WHERE s.workspace_id=sec.current_workspace() AND s.token_hash=p_hash AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND p.status='active';
END
$$;
REVOKE ALL ON FUNCTION gov.identity_session(text) FROM PUBLIC, backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_session(text) TO backbone_app;

