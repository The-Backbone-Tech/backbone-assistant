-- An owner or admin classifies operations in the workspace's catalogue. A change that only raises
-- (a higher class, or external) restricts agents and applies at once. One that lowers is an
-- elevation: in a personal workspace (one root of authority) it applies at once; otherwise it waits
-- for an owner or admin from outside the proposer's delegation tree. Built-in classes never move.
CREATE FUNCTION gov.classify_operations(p_changes jsonb) RETURNS TABLE (change_id uuid, decision_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := gov._admin();
  ch jsonb;
  cur record;
  lowers boolean := false;
  new_id uuid := gen_random_uuid();
  decision uuid;
BEGIN
  IF jsonb_typeof(p_changes) IS DISTINCT FROM 'array' OR jsonb_array_length(p_changes) = 0 THEN
    RAISE EXCEPTION 'invalid: a classification lists its changes';
  END IF;
  FOR ch IN SELECT * FROM jsonb_array_elements(p_changes) LOOP
    IF jsonb_typeof(ch -> 'class') IS DISTINCT FROM 'number' OR (ch ->> 'class')::numeric NOT IN (1, 2, 3, 4, 5, 6)
       OR coalesce(length(ch ->> 'operation'), 0) = 0 OR jsonb_typeof(ch -> 'external') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'invalid: each change names an operation, a class from 1 to 6 and whether it is external';
    END IF;
    SELECT * INTO cur FROM gov._operation_class(ch ->> 'operation', NULL, NULL, NULL);
    IF (ch ->> 'class')::smallint < cur.effect_class OR (cur.external AND NOT (ch ->> 'external')::boolean) THEN
      lowers := true;
    END IF;
  END LOOP;
  PERFORM gov._lock_workspace();
  INSERT INTO app.operation_changes (workspace_id, id, changes, status, proposed_by)
  VALUES (ws, new_id, p_changes, CASE WHEN lowers AND NOT sec.workspace_is_personal(ws) THEN 'open' ELSE 'applied' END, me);
  PERFORM gov._append('operations.classified', new_id::text, jsonb_build_object(
    'operations', (SELECT jsonb_agg(jsonb_build_object('operation', x ->> 'operation', 'class', (x ->> 'class')::int,
                                                       'external', (x ->> 'external')::boolean, 'description', sec.digest(x ->> 'description')))
                   FROM jsonb_array_elements(p_changes) x),
    'lowers', lowers));
  IF lowers AND NOT sec.workspace_is_personal(ws) THEN
    decision := gov._open_decision('elevation', new_id, me, me, 'elevation', sec.args_hash(p_changes),
                                   'Lower the class of operations in the catalogue.', true, 'person', NULL);
    UPDATE app.operation_changes SET decision_id = decision WHERE workspace_id = ws AND id = new_id;
  ELSE
    PERFORM gov._apply_classification(new_id);
  END IF;
  RETURN QUERY SELECT new_id, decision;
END
$$;
