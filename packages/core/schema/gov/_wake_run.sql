-- Wake a parked run: what it waited for was answered or cancelled. The queue hands it out once.
CREATE FUNCTION gov._wake_run(p_run uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  UPDATE app.runs SET woken = true WHERE workspace_id = sec.current_workspace() AND id = p_run AND status = 'waiting' AND NOT woken;
  IF FOUND THEN
    UPDATE ops.run_queue SET claimable_after = clock_timestamp() WHERE run_id = p_run;
  END IF;
END
$$;
