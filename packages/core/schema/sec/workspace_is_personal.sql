-- A personal workspace has one root of authority: its owner decides even strict questions.
CREATE FUNCTION sec.workspace_is_personal(p_workspace uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$ SELECT coalesce((SELECT kind = 'personal' FROM app.workspaces WHERE id = p_workspace), false) $$;
