-- Write a catalogue change's classes into the catalogue.
CREATE FUNCTION gov._apply_classification(p_change uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  c record;
BEGIN
  SELECT * INTO c FROM app.operation_changes x WHERE x.workspace_id = ws AND x.id = p_change;
  INSERT INTO app.operations (workspace_id, operation, effect_class, external, undo_operation, description)
  SELECT ws, x ->> 'operation', (x ->> 'class')::smallint, (x ->> 'external')::boolean, x ->> 'undo', x ->> 'description'
  FROM jsonb_array_elements(c.changes) x
  ON CONFLICT (workspace_id, operation) DO UPDATE
    SET effect_class = excluded.effect_class, external = excluded.external,
        undo_operation = coalesce(excluded.undo_operation, app.operations.undo_operation),
        description = coalesce(excluded.description, app.operations.description), updated_at = clock_timestamp();
  UPDATE app.operation_changes SET status = 'applied' WHERE workspace_id = ws AND id = p_change;
END
$$;
