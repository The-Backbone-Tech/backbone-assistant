-- The system principal records what a connected server answered a run's call: untrusted, always,
-- and belonging to the run's own task whatever the recorder states. A connection marked sensitive,
-- or a person's own (until they say otherwise), is private material.
CREATE FUNCTION gov.record_server_answer(p_run uuid, p_connection uuid, p_tool text, p_content text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := gov._system('system_records');
  c record;
  run_task uuid;
  sensitive text;
  new_id uuid := gen_random_uuid();
  tool text := coalesce(p_tool, 'read_inbox');
BEGIN
  SELECT * INTO c FROM app.connections x WHERE x.workspace_id = ws AND x.id = p_connection;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid: a server''s answer names its connection';
  END IF;
  SELECT r.task_id INTO run_task FROM app.runs r WHERE r.workspace_id = ws AND r.id = p_run;
  IF run_task IS NULL THEN
    RAISE EXCEPTION 'not_found: no such run in this workspace';
  END IF;
  IF c.sensitive THEN
    sensitive := 'the connected server ' || c.name || CASE WHEN c.scope = 'person'
      THEN ', ' || gov._person_name(c.owner_id) || '’s own' ELSE ', marked sensitive' END;
  END IF;
  INSERT INTO app.episodes (workspace_id, id, source_kind, source_ref, trust, sensitive, content, content_hash, recorded_by,
                            run_id, task_id, connection_id)
  VALUES (ws, new_id, 'mcp', 'mcp:' || c.id || '/' || tool, 'untrusted', sensitive IS NOT NULL, coalesce(p_content, ''),
          encode(sha256(convert_to(coalesce(p_content, ''), 'UTF8')), 'hex'), me, p_run, run_task, p_connection);
  PERFORM gov._mark(p_run, 'the connected server ' || c.name || ' (' || tool || ')', sensitive, sensitive);
  PERFORM gov._append('source.recorded', new_id::text, jsonb_build_object('kind', 'mcp', 'run', p_run, 'connection', p_connection,
                                                                          'tool', sec.digest(tool)));
  RETURN new_id;
END
$$;
