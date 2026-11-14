-- Claim a run the caller has locked: re-check its mandate first (a revoked or expired one cancels
-- it, a spent budget fails it, and nothing is claimed), then take it under a new fence and secret.
CREATE FUNCTION gov._claim(p_run uuid, p_worker text, p_lease_ms integer, OUT fence bigint, OUT secret text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  r record;
  standing text;
BEGIN
  IF p_lease_ms IS NULL OR p_lease_ms <= 0 THEN
    RAISE EXCEPTION 'invalid: a lease is a positive number of milliseconds';
  END IF;
  SELECT * INTO r FROM app.runs WHERE workspace_id = sec.current_workspace() AND id = p_run;
  standing := gov._mandate_standing(r.mandate_id);
  IF standing <> 'ok' THEN
    PERFORM gov._stop_run(p_run, CASE standing WHEN 'budget_exhausted' THEN 'failed' ELSE 'cancelled' END,
                          replace(standing, '_', ' '));
    fence := NULL;
    secret := NULL;
    RETURN;
  END IF;
  fence := r.fence + 1;
  secret := gen_random_uuid()::text || '.' || gen_random_uuid()::text;
  INSERT INTO ops.run_secrets (workspace_id, run_id, fence, secret_hash)
  VALUES (r.workspace_id, p_run, fence, encode(sha256(convert_to(secret, 'UTF8')), 'hex'));
  UPDATE app.runs SET status = 'running', fence = _claim.fence, worker = p_worker, woken = false,
                      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_ms / 1000.0),
                      started_at = coalesce(started_at, clock_timestamp())
  WHERE workspace_id = r.workspace_id AND id = p_run;
  UPDATE ops.run_queue SET claimable_after = clock_timestamp() + make_interval(secs => p_lease_ms / 1000.0) WHERE run_id = p_run;
  PERFORM gov._append('run.claimed', p_run::text, jsonb_build_object('fence', fence, 'worker', p_worker), sec.system_principal());
END
$$;
