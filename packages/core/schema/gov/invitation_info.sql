-- What an invitation offers, read by whoever holds its token, from an empty session.
CREATE FUNCTION gov.invitation_info(p_token_hash text)
RETURNS TABLE (workspace_id uuid, role text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  IF NOT sec.session_is_empty() THEN
    RAISE EXCEPTION 'empty_session_only: an invitation is read from a session that names nobody';
  END IF;
  RETURN QUERY SELECT i.workspace_id, i.role, i.expires_at FROM ops.invitations i
    WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL AND i.expires_at > clock_timestamp();
END
$$;
