-- A person's role in the session's workspace ('owner', 'admin', 'member', 'guest'), or NULL.
CREATE FUNCTION sec.role_of(p_principal uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT role FROM app.principals
  WHERE workspace_id = sec.current_workspace() AND id = p_principal AND kind = 'person' AND status = 'active'
$$;
