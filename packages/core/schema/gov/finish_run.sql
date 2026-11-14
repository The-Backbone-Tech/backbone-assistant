-- The holder of a running run finishes it.
CREATE FUNCTION gov.finish_run(p_run uuid, p_fence bigint, p_outcome text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  r app.runs := gov._holder(p_run, p_fence);
BEGIN
  IF r.status <> 'running' THEN
    RAISE EXCEPTION 'stale: the run is no longer running';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'invalid: a run finishes succeeded or failed';
  END IF;
  UPDATE app.runs SET status = p_outcome, finished_at = clock_timestamp(), lease_expires_at = NULL
  WHERE workspace_id = r.workspace_id AND id = p_run;
  DELETE FROM ops.run_queue WHERE run_id = p_run;
  PERFORM gov._append('run.finished', p_run::text, jsonb_build_object('outcome', p_outcome, 'fence', p_fence));
  RETURN p_outcome;
END
$$;
