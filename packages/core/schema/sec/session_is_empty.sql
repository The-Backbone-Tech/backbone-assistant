-- A session that names nobody: no workspace, no principal, no run. Crossings that choose a workspace
-- for themselves (queues, invitations, the first workspace) start only from one.
CREATE FUNCTION sec.session_is_empty() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$
  SELECT nullif(current_setting('backbone.workspace', true), '') IS NULL
     AND nullif(current_setting('backbone.principal', true), '') IS NULL
     AND nullif(current_setting('backbone.run', true), '') IS NULL
$$;
