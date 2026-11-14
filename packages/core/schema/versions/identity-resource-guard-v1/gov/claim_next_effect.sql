-- A dispatcher takes the next due effect of any workspace, from an empty session, as that
-- workspace's system principal, and leaves the session empty. A dispatching effect whose
-- dispatcher went silent comes back as stale, with its claim, once its lease and the grace window
-- (30 seconds; effect-gateway contract, stale dispatch) have passed: to be inspected and observed, never sent again.
CREATE OR REPLACE FUNCTION gov.claim_next_effect(p_worker text, p_lease_ms integer)
RETURNS TABLE (workspace_id uuid, effect_id uuid, claim_token text, stale boolean, system_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  grace constant interval := interval '30 seconds';
  q record;
  e record;
  v_claim text;
  v_system uuid;
BEGIN
  IF NOT sec.session_is_empty() THEN
    RAISE EXCEPTION 'empty_session_only: the queue is read from a session that names nobody';
  END IF;
  IF p_lease_ms IS NULL OR p_lease_ms <= 0 THEN
    RAISE EXCEPTION 'invalid: a lease is a positive number of milliseconds';
  END IF;
  LOOP
    SELECT * INTO q FROM ops.effect_queue x WHERE x.due_at <= clock_timestamp()
    ORDER BY x.due_at, x.enqueued_at LIMIT 1 FOR UPDATE SKIP LOCKED;
    EXIT WHEN NOT FOUND;
    PERFORM set_config('backbone.workspace', q.workspace_id::text, true);
    PERFORM set_config('backbone.principal',sec.system_principal()::text,true);
    v_system := sec.system_principal();
    SELECT * INTO e FROM app.effects x WHERE x.workspace_id = q.workspace_id AND x.id = q.effect_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      UPDATE ops.effect_queue x SET due_at = clock_timestamp() + interval '1 second' WHERE x.effect_id = q.effect_id;
    ELSIF (e.status = 'allowed' AND (e.not_before IS NULL OR e.not_before <= clock_timestamp()))
          OR (e.status = 'claimed' AND q.lease_expires_at <= clock_timestamp()) THEN
      v_claim := gov._claim_effect(e.id, p_lease_ms);
      PERFORM set_config('backbone.principal','',true);
    PERFORM set_config('backbone.workspace', '', true);
      RETURN QUERY SELECT q.workspace_id, e.id, v_claim, false, v_system;
      RETURN;
    ELSIF e.status = 'allowed' THEN
      UPDATE ops.effect_queue x SET due_at = e.not_before WHERE x.effect_id = q.effect_id;
    ELSIF e.status = 'claimed' THEN
      UPDATE ops.effect_queue x SET due_at = q.lease_expires_at WHERE x.effect_id = q.effect_id;
    ELSIF e.status = 'dispatching' AND q.lease_expires_at + grace <= clock_timestamp()
          AND (q.stale_handed_until IS NULL OR q.stale_handed_until <= clock_timestamp()) THEN
      UPDATE ops.effect_queue x SET stale_handed_until = clock_timestamp() + make_interval(secs => p_lease_ms / 1000.0),
                                    due_at = clock_timestamp() + make_interval(secs => p_lease_ms / 1000.0)
      WHERE x.effect_id = q.effect_id;
      PERFORM set_config('backbone.principal','',true);
    PERFORM set_config('backbone.workspace', '', true);
      RETURN QUERY SELECT q.workspace_id, e.id, q.claim_token, true, v_system;
      RETURN;
    ELSIF e.status = 'dispatching' THEN
      UPDATE ops.effect_queue x SET due_at = greatest(q.lease_expires_at + grace, coalesce(q.stale_handed_until, q.lease_expires_at + grace))
      WHERE x.effect_id = q.effect_id;
    ELSE
      DELETE FROM ops.effect_queue x WHERE x.effect_id = q.effect_id;
    END IF;
    PERFORM set_config('backbone.principal','',true);
    PERFORM set_config('backbone.workspace', '', true);
  END LOOP;
  PERFORM set_config('backbone.principal','',true);
    PERFORM set_config('backbone.workspace', '', true);
END
$$;
