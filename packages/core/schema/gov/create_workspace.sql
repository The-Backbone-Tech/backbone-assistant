-- The service creates an installation's first workspace, from an empty session; every later one is
-- the operator's (operator.create_workspace).
CREATE FUNCTION gov.create_workspace(p_name text, p_kind text, p_owner_name text, p_owner_email text)
RETURNS TABLE (workspace_id uuid, owner_id uuid, system_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  first uuid;
BEGIN
  IF NOT sec.session_is_empty() THEN
    RAISE EXCEPTION 'empty_session_only: a workspace is created from a session that names nobody';
  END IF;
  SELECT i.first_workspace INTO first FROM ops.installation i FOR UPDATE;
  IF first IS NOT NULL THEN
    RAISE EXCEPTION 'role: every workspace after the first is the operator''s to create';
  END IF;
  RETURN QUERY SELECT * FROM gov._create_workspace(p_name, p_kind, p_owner_name, p_owner_email);
  UPDATE ops.installation SET first_workspace = sec.current_workspace();
END
$$;
