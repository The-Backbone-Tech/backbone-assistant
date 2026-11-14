-- Whether the session's workspace has an active verifier.
CREATE FUNCTION gov._has_verifier() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (SELECT FROM app.principals WHERE workspace_id = sec.current_workspace() AND kind = 'agent'
                 AND agent_role = 'verifier' AND status = 'active')
$$;
