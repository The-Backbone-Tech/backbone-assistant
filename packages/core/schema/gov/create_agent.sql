-- A person creates an agent. A worker is its creator's; a verifier belongs to the workspace (its
-- system principal) and only an owner or admin creates one. Guests create none.
CREATE FUNCTION gov.create_agent(p_name text, p_role text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := gov._person();
  new_id uuid := gen_random_uuid();
  owner uuid;
BEGIN
  IF p_role IS NULL OR p_role NOT IN ('worker', 'verifier') THEN
    RAISE EXCEPTION 'invalid: an agent is a worker or a verifier';
  END IF;
  IF sec.role_of(me) = 'guest' THEN
    RAISE EXCEPTION 'role: a guest creates no agents';
  END IF;
  IF p_role = 'verifier' AND NOT sec.is_admin(me) THEN
    RAISE EXCEPTION 'role: only an owner or an admin creates a verifier';
  END IF;
  owner := CASE p_role WHEN 'verifier' THEN sec.system_principal() ELSE me END;
  INSERT INTO app.principals (workspace_id, id, kind, agent_role, owner_id, name)
  VALUES (sec.current_workspace(), new_id, 'agent', p_role, owner, p_name);
  PERFORM gov._append('agent.created', new_id::text, jsonb_build_object('role', p_role, 'owner', owner));
  RETURN new_id;
END
$$;
