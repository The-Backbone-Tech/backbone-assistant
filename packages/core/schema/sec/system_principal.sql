-- The session's workspace's system principal: it dispatches effects and records sources.
CREATE FUNCTION sec.system_principal() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$ SELECT id FROM app.principals WHERE workspace_id = sec.current_workspace() AND kind = 'system' $$;
