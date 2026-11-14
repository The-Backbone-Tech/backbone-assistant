-- The holder renews its run's lease.
CREATE FUNCTION gov.renew_run_lease(p_run uuid, p_fence bigint, p_lease_ms integer) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  r app.runs := gov._holder(p_run, p_fence);
  until timestamptz;
BEGIN
  IF r.status <> 'running' THEN
    RAISE EXCEPTION 'stale: the run is no longer running';
  END IF;
  IF p_lease_ms IS NULL OR p_lease_ms <= 0 THEN
    RAISE EXCEPTION 'invalid: a lease is a positive number of milliseconds';
  END IF;
  until := clock_timestamp() + make_interval(secs => p_lease_ms / 1000.0);
  UPDATE app.runs SET lease_expires_at = until WHERE workspace_id = r.workspace_id AND id = p_run;
  UPDATE ops.run_queue SET claimable_after = until WHERE run_id = p_run;
  RETURN until;
END
$$;
