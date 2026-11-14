-- A person connects a server: their own (private material until they say otherwise), or, as an
-- owner or admin, the workspace's. In shared places a person's own connection is named by its id.
CREATE FUNCTION gov.register_connection(p_name text, p_slug text, p_url text, p_scope text, p_auth text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := gov._person('not_by_runs');
  new_id uuid := gen_random_uuid();
BEGIN
  IF p_scope IS NULL OR p_scope NOT IN ('workspace', 'person') THEN
    RAISE EXCEPTION 'invalid: a connection is the workspace''s or a person''s own';
  END IF;
  IF p_slug IS NULL OR p_slug !~ '^[a-z][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'invalid: a connection''s slug is lowercase letters, digits and underscores';
  END IF;
  IF p_scope = 'workspace' AND NOT sec.is_admin(me) THEN
    RAISE EXCEPTION 'role: an owner or an admin connects the workspace''s servers';
  END IF;
  IF EXISTS (SELECT FROM app.connections c WHERE c.workspace_id = sec.current_workspace() AND c.slug = p_slug) THEN
    RAISE EXCEPTION 'conflict: the slug is taken';
  END IF;
  INSERT INTO app.connections (workspace_id, id, name, slug, url, scope, owner_id, auth, sensitive)
  VALUES (sec.current_workspace(), new_id, coalesce(p_name, p_slug), p_slug, p_url, p_scope,
          CASE WHEN p_scope = 'person' THEN me END, coalesce(p_auth, 'none'), p_scope = 'person');
  PERFORM gov._append('connection.registered', new_id::text, jsonb_build_object(
    'scope', p_scope, 'slug', CASE WHEN p_scope = 'workspace' THEN p_slug END));
  RETURN new_id;
END
$$;
