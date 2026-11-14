-- Only a person can form this authority. Caller-selected ids and historical replay do not exist.
CREATE OR REPLACE FUNCTION gov.give_connector_signature(p_connection uuid, p_tool text, p_definition text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  me uuid;
  ws uuid := sec.current_workspace();
  connection record;
  signature uuid;
BEGIN
  IF sec.names_run() THEN RAISE EXCEPTION 'not_by_runs: a run never gives a signature'; END IF;
  PERFORM gov._lock_workspace();
  me := gov._person();
  IF p_definition IS NULL OR p_definition !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid: a signature binds an opaque SHA-256 definition digest';
  END IF;
  SELECT c.* INTO connection FROM app.connections c WHERE c.workspace_id=ws AND c.id=p_connection;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found: no such connection in this workspace'; END IF;
  IF connection.scope='person' AND connection.owner_id IS DISTINCT FROM me THEN
    RAISE EXCEPTION 'someone_else: only its person signs their connection';
  END IF;
  IF NOT EXISTS (SELECT FROM app.connection_tools t WHERE t.workspace_id=ws AND t.connection_id=p_connection
      AND t.name=p_tool AND t.removed_at IS NULL) THEN
    RAISE EXCEPTION 'not_found: no such current tool on this connection';
  END IF;
  -- Supersede abandoned grants too: a lost give reply never leaves an extra live authority.
  PERFORM gov.end_connector_signature(s.id,'superseded') FROM app.connector_signatures s
    WHERE s.workspace_id=ws AND s.person_id=me AND s.connection_id=p_connection
      AND s.tool_name=p_tool AND s.ended_at IS NULL;
  INSERT INTO app.connector_signatures(workspace_id,person_id,connection_id,tool_name,operation,definition_digest)
    VALUES(ws,me,p_connection,p_tool,'mcp.'||connection.slug||'.'||p_tool,p_definition) RETURNING id INTO signature;
  PERFORM gov._append('signature.given',signature::text,jsonb_build_object(
    'signature',signature,'connection',p_connection,'tool_hash',sec.digest(p_tool),'definition_digest',sec.digest(p_definition)),me);
  RETURN signature;
END
$$;
