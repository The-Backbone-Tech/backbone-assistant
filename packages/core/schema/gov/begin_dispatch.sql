-- The system principal begins dispatching an effect it holds the current claim of. Authority is
-- re-read as it is spent: an effect whose mandate expired meanwhile is cancelled and nothing is
-- sent (false). From here the effect can only be observed.
CREATE FUNCTION gov.begin_dispatch(p_effect uuid, p_claim text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  grace constant interval := interval '30 seconds';
  e record;
  q record;
  standing text;
BEGIN
  PERFORM gov._system();
  PERFORM gov._lock_workspace();
  SELECT * INTO e FROM app.effects x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_effect FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such effect in this workspace';
  END IF;
  SELECT * INTO q FROM ops.effect_queue x WHERE x.effect_id = p_effect;
  IF e.status <> 'claimed' OR q.claim_token IS DISTINCT FROM p_claim OR q.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'stale: this claim no longer holds the effect';
  END IF;
  IF e.mandate_id IS NOT NULL THEN
    standing := gov._mandate_standing(e.mandate_id);
    IF standing IN ('mandate_revoked', 'mandate_expired') THEN
      PERFORM gov._cancel_effect(p_effect, replace(standing, '_', ' '));
      RETURN false;
    END IF;
  END IF;
  UPDATE app.effects SET status = 'dispatching', dispatcher_id = sec.current_principal() WHERE workspace_id = e.workspace_id AND id = p_effect;
  UPDATE ops.effect_queue x SET due_at = q.lease_expires_at + grace WHERE x.effect_id = p_effect;
  PERFORM gov._append('effect.dispatched', p_effect::text, gov._effect_payload(p_effect) || jsonb_build_object('dispatcher', sec.current_principal()));
  RETURN true;
END
$$;
