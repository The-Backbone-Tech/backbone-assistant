-- Whether the session names a run at all (held or not). A session that names a run acts only as it.
CREATE FUNCTION sec.names_run() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('backbone.run', true), '') IS NOT NULL $$;
