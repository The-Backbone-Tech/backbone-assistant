-- A principal's name, as the crossings' own sentences say it.
CREATE FUNCTION gov._person_name(p_principal uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$ SELECT name FROM app.principals WHERE workspace_id = sec.current_workspace() AND id = p_principal $$;
