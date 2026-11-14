-- Cancel an effect before its dispatch begins: the person it is for, an owner or admin who sees
-- it, or the system principal. Once dispatch began it is too late: it can only be observed.
CREATE FUNCTION gov.cancel_effect(p_effect uuid, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := sec.current_principal();
  e record;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no_identity: the session acts as nobody';
  END IF;
  PERFORM gov._lock_workspace();
  SELECT * INTO e FROM app.effects x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_effect FOR UPDATE;
  IF NOT FOUND OR NOT sec.effect_visible(p_effect) THEN
    RAISE EXCEPTION 'not_found: no such effect for this session';
  END IF;
  IF sec.names_run() OR NOT (me = e.on_behalf_of_id OR me = e.proposer_id OR me = sec.system_principal() OR sec.is_admin(me)) THEN
    RAISE EXCEPTION 'role: an effect is cancelled by its person, an admin or the system';
  END IF;
  IF e.status IN ('dispatching', 'unknown', 'succeeded', 'failed') THEN
    RAISE EXCEPTION 'too_late: dispatch already began';
  END IF;
  IF e.status NOT IN ('proposed', 'awaiting_checker', 'allowed', 'claimed') THEN
    RAISE EXCEPTION 'not_open: the effect is already settled';
  END IF;
  PERFORM gov._cancel_effect(p_effect, p_reason);
  RETURN 'cancelled';
END
$$;
