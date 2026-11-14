-- What the ledger records of an effect: identifiers and digests. A person's own connection is
-- named by its id, and neither its slug, the operation through it nor the tool appear.
CREATE FUNCTION gov._effect_payload(p_effect uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'operation', CASE WHEN c.scope = 'person' THEN NULL ELSE e.operation END,
    'connection', CASE WHEN c.scope = 'person' THEN to_jsonb(c.id) ELSE to_jsonb(e.connection) END,
    'tool_hash', sec.digest(e.tool),
    'args_hash', e.args_hash,
    'class', e.effect_class,
    'undo_of', e.undo_of)
  FROM app.effects e
  LEFT JOIN app.connections c ON c.workspace_id = e.workspace_id AND c.id = e.connection_id
  WHERE e.workspace_id = sec.current_workspace() AND e.id = p_effect
$$;
