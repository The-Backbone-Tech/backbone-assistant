-- The run's current holder completes a pending step, whichever fence wrote it. Returns how many
-- steps it completed: none for a session that does not hold the run.
CREATE FUNCTION gov.complete_step(p_run uuid, p_seq integer, p_output jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  n integer;
BEGIN
  IF sec.current_run() IS DISTINCT FROM p_run THEN
    RETURN 0;
  END IF;
  UPDATE app.run_steps SET output = coalesce(p_output, '{}'), status = 'done', completed_at = clock_timestamp()
  WHERE workspace_id = sec.current_workspace() AND run_id = p_run AND seq = p_seq AND status = 'pending';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
