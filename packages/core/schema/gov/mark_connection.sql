-- Mark a connection as holding private material, or lift the mark. Anyone who sees it may mark it;
-- a workspace connection's mark is lifted by an owner or admin, a person's own by that person.
-- Runs mark nothing.
CREATE FUNCTION gov.mark_connection(p_connection uuid, p_sensitive boolean) RETURNS boolean
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
  IF p_sensitive IS NULL THEN
    RAISE EXCEPTION 'invalid: a mark is set or lifted';
  END IF;
  IF NOT p_sensitive AND c.scope = 'workspace' AND NOT sec.is_admin(me) THEN
    RAISE EXCEPTION 'role: an owner or admin lifts a workspace connection''s mark';
  END IF;
  UPDATE app.connections SET sensitive = p_sensitive WHERE workspace_id = c.workspace_id AND id = p_connection;
  PERFORM gov._append('connection.marked', p_connection::text, jsonb_build_object(
    'sensitive', p_sensitive, 'slug', CASE WHEN c.scope = 'workspace' THEN c.slug END));
  RETURN p_sensitive;
END
$$;
