-- Cancel an effect that was not dispatched: its open question is withdrawn, it leaves the queues,
-- and a run parked waiting on it wakes.
CREATE FUNCTION gov._cancel_effect(p_effect uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  e record;
BEGIN
  SELECT * INTO e FROM app.effects x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_effect;
  UPDATE app.effects SET status = 'cancelled', cancel_reason = p_reason WHERE workspace_id = e.workspace_id AND id = p_effect;
  UPDATE app.decisions SET status = 'withdrawn' WHERE workspace_id = e.workspace_id AND subject_id = p_effect AND status = 'open';
  DELETE FROM ops.verification_queue x WHERE x.decision_id = e.decision_id;
  DELETE FROM ops.effect_queue x WHERE x.effect_id = p_effect;
  IF e.run_id IS NOT NULL THEN
    PERFORM gov._wake_run(e.run_id);
  END IF;
  PERFORM gov._append('effect.cancelled', p_effect::text, jsonb_build_object('reason', sec.digest(p_reason)));
END
$$;
