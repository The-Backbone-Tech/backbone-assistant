-- The workspace the session names. Every tenant store's wall compares against it; with none, no rows.
CREATE FUNCTION sec.current_workspace() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('backbone.workspace', true), '')::uuid $$;
