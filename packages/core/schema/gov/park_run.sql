-- The holder parks its run to wait for an answer or a cancellation, which wakes it.
CREATE FUNCTION gov.park_run(p_run uuid, p_fence bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  r app.runs := gov._holder(p_run, p_fence);
BEGIN
  IF r.status <> 'running' THEN
    RAISE EXCEPTION 'stale: the run is no longer running';
  END IF;
  UPDATE app.runs SET status = 'waiting', woken = false, lease_expires_at = NULL WHERE workspace_id = r.workspace_id AND id = p_run;
  UPDATE ops.run_queue SET claimable_after = NULL WHERE run_id = p_run;
  PERFORM gov._append('run.parked', p_run::text, jsonb_build_object('fence', p_fence));
  RETURN 'waiting';
END
$$;
