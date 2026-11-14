-- Claim a locked, claimable effect under a new claim and lease. Returns the claim, which is
-- worth something only to the workspace's system principal.
CREATE FUNCTION gov._claim_effect(p_effect uuid, p_lease_ms integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  v_claim text := gen_random_uuid()::text;
  v_until timestamptz;
BEGIN
  IF p_lease_ms IS NULL OR p_lease_ms <= 0 THEN
    RAISE EXCEPTION 'invalid: a lease is a positive number of milliseconds';
  END IF;
  v_until := clock_timestamp() + make_interval(secs => p_lease_ms / 1000.0);
  UPDATE app.effects SET status = 'claimed', dispatcher_id = sec.system_principal()
  WHERE workspace_id = sec.current_workspace() AND id = p_effect AND status <> 'claimed';
  INSERT INTO ops.effect_queue (effect_id, workspace_id, due_at, claim_token, lease_expires_at)
  VALUES (p_effect, sec.current_workspace(), v_until, v_claim, v_until)
  ON CONFLICT (effect_id) DO UPDATE SET due_at = v_until, claim_token = v_claim, lease_expires_at = v_until, stale_handed_until = NULL;
  RETURN v_claim;
END
$$;
