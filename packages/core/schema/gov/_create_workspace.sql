-- Create a workspace with its owner, its system principal, its digest key and its ledger, and
-- leave the session in it.
CREATE FUNCTION gov._create_workspace(p_name text, p_kind text, p_owner_name text, p_owner_email text)
RETURNS TABLE (workspace_id uuid, owner_id uuid, system_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := gen_random_uuid();
  owner uuid := gen_random_uuid();
  sys uuid := gen_random_uuid();
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('personal', 'team', 'company') THEN
    RAISE EXCEPTION 'invalid: a workspace is personal, team or company';
  END IF;
  IF p_name IS NULL OR length(p_name) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid: a workspace needs a name';
  END IF;
  PERFORM set_config('backbone.workspace', ws::text, true);
  PERFORM set_config('backbone.principal', '', true);
  PERFORM set_config('backbone.run', '', true);
  PERFORM set_config('backbone.secret', '', true);
  INSERT INTO app.workspaces (id, name, kind) VALUES (ws, p_name, p_kind);
  INSERT INTO app.ledger_heads (workspace_id) VALUES (ws);
  INSERT INTO ops.workspace_keys (workspace_id, digest_key) VALUES (ws, crypto.gen_random_bytes(32));
  INSERT INTO app.principals (workspace_id, id, kind, role, name, email) VALUES (ws, owner, 'person', 'owner', p_owner_name, p_owner_email);
  INSERT INTO app.principals (workspace_id, id, kind, name) VALUES (ws, sys, 'system', 'System');
  PERFORM gov._append('workspace.created', ws::text, jsonb_build_object('kind', p_kind, 'owner', owner, 'system', sys), owner);
  RETURN QUERY SELECT ws, owner, sys;
END
$$;
