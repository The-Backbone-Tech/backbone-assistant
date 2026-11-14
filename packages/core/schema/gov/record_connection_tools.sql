-- The system principal records what a connected server listed: its current tools replace the last
-- ones. Returns how many tools it lists.
CREATE FUNCTION gov.record_connection_tools(p_connection uuid, p_status text, p_tools jsonb, p_error text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  c record;
  n integer;
BEGIN
  PERFORM gov._system('system_records');
  SELECT * INTO c FROM app.connections x WHERE x.workspace_id = ws AND x.id = p_connection;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such connection in this workspace';
  END IF;
  IF jsonb_typeof(coalesce(p_tools, '[]')) <> 'array' THEN
    RAISE EXCEPTION 'invalid: tools are a list';
  END IF;
  UPDATE app.connection_tools t SET removed_at = clock_timestamp()
  WHERE t.workspace_id = ws AND t.connection_id = p_connection AND t.removed_at IS NULL
    AND NOT EXISTS (SELECT FROM jsonb_array_elements(coalesce(p_tools, '[]')) x WHERE x ->> 'name' = t.name);
  INSERT INTO app.connection_tools (workspace_id, connection_id, name, title, input_schema)
  SELECT ws, p_connection, x ->> 'name', x ->> 'title', x -> 'input_schema' FROM jsonb_array_elements(coalesce(p_tools, '[]')) x
  ON CONFLICT (workspace_id, connection_id, name) DO UPDATE
    SET title = excluded.title, input_schema = excluded.input_schema, discovered_at = clock_timestamp(), removed_at = NULL;
  UPDATE app.connections SET status = coalesce(p_status, 'ok') WHERE workspace_id = ws AND id = p_connection;
  SELECT count(*) INTO n FROM app.connection_tools t WHERE t.workspace_id = ws AND t.connection_id = p_connection AND t.removed_at IS NULL;
  PERFORM gov._append('connection.checked', p_connection::text, jsonb_build_object(
    'status', coalesce(p_status, 'ok'), 'tools', n, 'slug', CASE WHEN c.scope = 'workspace' THEN c.slug END,
    'error', sec.digest(p_error)));
  RETURN n;
END
$$;
