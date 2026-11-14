-- Its person (or for a workspace connection an owner or admin) records that a connection was
-- signed in, with the scopes granted. The tokens themselves are sealed secrets, held by handle
-- outside this record. Signing in grants access to the account; it fixes no outbound argument.
CREATE FUNCTION gov.sign_in_connection(p_connection uuid, p_url text, p_scopes text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := gov._person('not_by_runs');
  c record;
BEGIN
  SELECT * INTO c FROM app.connections x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_connection;
  IF NOT FOUND OR (c.scope = 'person' AND c.owner_id <> me) THEN
    RAISE EXCEPTION 'not_found: no such connection for this person';
  END IF;
  IF c.scope = 'workspace' AND NOT sec.is_admin(me) THEN
    RAISE EXCEPTION 'role: an owner or admin signs the workspace''s connections in';
  END IF;
  UPDATE app.connections SET url = coalesce(p_url, url), scopes = p_scopes, status = 'signed_in'
  WHERE workspace_id = c.workspace_id AND id = p_connection;
  PERFORM gov._append('connection.signed_in', p_connection::text, jsonb_build_object(
    'slug', CASE WHEN c.scope = 'workspace' THEN c.slug END, 'scopes', sec.digest(p_scopes)));
  RETURN p_connection;
END
$$;
