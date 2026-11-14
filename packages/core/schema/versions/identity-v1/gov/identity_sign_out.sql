-- Identity operations serialize admission and revocation before observing authority.
CREATE FUNCTION gov.identity_sign_out(p_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  UPDATE app.identity_sessions SET revoked_at=clock_timestamp() WHERE workspace_id=sec.current_workspace() AND token_hash=p_hash AND revoked_at IS NULL;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_sign_out(text) FROM PUBLIC, backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_sign_out(text) TO backbone_app;

