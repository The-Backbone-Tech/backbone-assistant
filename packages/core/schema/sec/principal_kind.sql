-- 'person', 'agent', 'system', or NULL for a principal not in the session's workspace.
CREATE FUNCTION sec.principal_kind(p_principal uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$ SELECT kind FROM app.principals WHERE workspace_id = sec.current_workspace() AND id = p_principal $$;
