-- The system principal claims an allowed effect for dispatch (or one whose last claim lapsed).
-- Nothing else claims: not the proposing agent, not a person. An effect inside its cancellation
-- window waits for the window to end.
CREATE FUNCTION gov.claim_effect(p_effect uuid, p_lease_ms integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  e record;
  q record;
BEGIN
  PERFORM gov._system();
  SELECT * INTO e FROM app.effects x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_effect FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such effect in this workspace';
  END IF;
  SELECT * INTO q FROM ops.effect_queue x WHERE x.effect_id = p_effect;
  IF e.status = 'allowed' THEN
    IF e.not_before IS NOT NULL AND e.not_before > clock_timestamp() THEN
      RAISE EXCEPTION 'window: the effect is inside its workspace''s cancellation window';
    END IF;
  ELSIF NOT (e.status = 'claimed' AND (q.lease_expires_at IS NULL OR q.lease_expires_at <= clock_timestamp())) THEN
    RAISE EXCEPTION 'not_claimable: the effect is not waiting to be dispatched';
  END IF;
  RETURN gov._claim_effect(p_effect, p_lease_ms);
END
$$;
