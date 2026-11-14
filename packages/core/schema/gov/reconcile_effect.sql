-- Settle an UNKNOWN outcome by inspection: its named resolver, the dispatcher (the system
-- principal) or an owner or admin. Never the proposing agent, never a run.
CREATE FUNCTION gov.reconcile_effect(p_effect uuid, p_outcome text, p_external_ref text, p_observation_hash text, p_note text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := sec.current_principal();
  e record;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'reconciler: the session acts as nobody';
  END IF;
  PERFORM gov._lock_workspace();
  SELECT * INTO e FROM app.effects x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_effect FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such effect in this workspace';
  END IF;
  IF sec.names_run() OR NOT (me = sec.system_principal() OR me = e.resolver_id OR sec.is_admin(me)) THEN
    RAISE EXCEPTION 'reconciler: only its resolver, the dispatcher or an admin settles an unknown outcome';
  END IF;
  IF e.status <> 'unknown' THEN
    RAISE EXCEPTION 'not_open: the effect''s outcome is not unknown';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'invalid: an unknown outcome settles as succeeded or failed';
  END IF;
  UPDATE app.effects SET status = p_outcome, external_ref = coalesce(p_external_ref, external_ref),
                         observation_hash = coalesce(p_observation_hash, observation_hash), note = p_note, settled_by = me
  WHERE workspace_id = e.workspace_id AND id = p_effect;
  PERFORM gov._append('effect.reconciled', p_effect::text, jsonb_build_object(
    'outcome', p_outcome, 'settled_by', me, 'note', sec.digest(p_note), 'args_hash', e.args_hash));
  RETURN p_outcome;
END
$$;
