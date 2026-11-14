-- The run, while it acts, writes a step at its current fence. A run that does not act (no secret,
-- an old fence, a stopped run, a mandate that no longer stands) writes nothing.
CREATE FUNCTION gov.write_step(p_run uuid, p_seq integer, p_kind text, p_title text, p_input jsonb, p_fence bigint) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  r record;
  v_seq integer;
BEGIN
  SELECT * INTO r FROM app.runs WHERE workspace_id = sec.current_workspace() AND id = p_run;
  IF NOT FOUND OR sec.current_run() IS DISTINCT FROM p_run OR p_fence IS DISTINCT FROM r.fence THEN
    RAISE EXCEPTION 'denied: only the run, at its current fence, writes its steps';
  END IF;
  IF gov._mandate_standing(r.mandate_id) <> 'ok' THEN
    RAISE EXCEPTION 'denied: the run''s mandate no longer stands';
  END IF;
  v_seq := coalesce(p_seq, (SELECT coalesce(max(s.seq), 0) + 1 FROM app.run_steps s WHERE s.workspace_id = r.workspace_id AND s.run_id = p_run));
  IF EXISTS (SELECT FROM app.run_steps s WHERE s.workspace_id = r.workspace_id AND s.run_id = p_run AND s.seq = v_seq) THEN
    RAISE EXCEPTION 'conflict: the step is already written';
  END IF;
  INSERT INTO app.run_steps (workspace_id, run_id, seq, kind, title, input, fence)
  VALUES (r.workspace_id, p_run, v_seq, coalesce(p_kind, 'wait'), p_title, coalesce(p_input, '{}'), r.fence);
  RETURN v_seq;
END
$$;
