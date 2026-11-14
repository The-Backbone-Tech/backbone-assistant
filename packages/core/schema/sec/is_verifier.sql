-- One of the workspace's verifier agents.
CREATE FUNCTION sec.is_verifier(p_principal uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (SELECT FROM app.principals WHERE workspace_id = sec.current_workspace() AND id = p_principal
                 AND kind = 'agent' AND agent_role = 'verifier' AND status = 'active')
$$;
