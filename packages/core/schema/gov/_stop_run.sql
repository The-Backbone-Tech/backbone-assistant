-- Stop a run for good: it leaves the queue and its holder's secret acts no more.
CREATE FUNCTION gov._stop_run(p_run uuid, p_status text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  UPDATE app.runs SET status = p_status, stop_reason = p_reason, finished_at = clock_timestamp(), lease_expires_at = NULL
  WHERE workspace_id = sec.current_workspace() AND id = p_run;
  DELETE FROM ops.run_queue WHERE run_id = p_run;
  PERFORM gov._append('run.stopped', p_run::text, jsonb_build_object('status', p_status, 'reason', p_reason));
END
$$;
