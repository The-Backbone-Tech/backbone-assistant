-- An allowed effect enters the dispatch queue, due when its cancellation window ends.
CREATE FUNCTION gov._enqueue_effect(p_effect uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  INSERT INTO ops.effect_queue (effect_id, workspace_id, due_at)
  SELECT e.id, e.workspace_id, greatest(clock_timestamp(), coalesce(e.not_before, clock_timestamp()))
  FROM app.effects e WHERE e.workspace_id = sec.current_workspace() AND e.id = p_effect
  ON CONFLICT (effect_id) DO UPDATE SET due_at = excluded.due_at, claim_token = NULL, lease_expires_at = NULL;
END
$$;
