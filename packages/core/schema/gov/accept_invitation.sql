-- Accept an invitation for an account, from an empty session: the account becomes a person of the
-- workspace, and the session is left as empty as it came.
CREATE FUNCTION gov.accept_invitation(p_token_hash text, p_user text)
RETURNS TABLE (workspace_id uuid, principal_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  inv record;
  new_id uuid := gen_random_uuid();
BEGIN
  IF NOT sec.session_is_empty() THEN
    RAISE EXCEPTION 'empty_session_only: an invitation is accepted from a session that names nobody';
  END IF;
  SELECT * INTO inv FROM ops.invitations i
    WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL AND i.expires_at > clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM set_config('backbone.workspace', inv.workspace_id::text, true);
  INSERT INTO app.principals (workspace_id, id, kind, role, name, user_id)
  VALUES (inv.workspace_id, new_id, 'person', inv.role, p_user, p_user);
  UPDATE ops.invitations SET accepted_by = p_user, accepted_at = clock_timestamp() WHERE token_hash = p_token_hash;
  PERFORM gov._append('person.added', new_id::text, jsonb_build_object('role', inv.role, 'invited_by', inv.invited_by), id);
  PERFORM set_config('backbone.workspace', '', true);
  RETURN QUERY SELECT inv.workspace_id, new_id;
END
$$;
