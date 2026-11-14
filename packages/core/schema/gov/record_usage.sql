-- The holder records what its run spent, even once its run was stopped: spending that happened is
-- recorded, and charged to every ancestor of its mandate. Returns the mandate's standing, which
-- tells the worker whether to go on.
CREATE FUNCTION gov.record_usage(p_run uuid, p_fence bigint, p_tokens_in bigint, p_tokens_out bigint, p_cost_micros bigint DEFAULT 0)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  r app.runs := gov._holder(p_run, p_fence);
BEGIN
  IF coalesce(p_tokens_in, 0) < 0 OR coalesce(p_tokens_out, 0) < 0 OR coalesce(p_cost_micros, 0) < 0 THEN
    RAISE EXCEPTION 'invalid: usage is never negative';
  END IF;
  PERFORM gov._lock_workspace();
  UPDATE app.runs SET tokens_used = tokens_used + coalesce(p_tokens_in, 0) + coalesce(p_tokens_out, 0),
                      cost_micros = cost_micros + coalesce(p_cost_micros, 0)
  WHERE workspace_id = r.workspace_id AND id = p_run;
  PERFORM gov._append('run.usage', p_run::text, jsonb_build_object(
    'tokens', coalesce(p_tokens_in, 0) + coalesce(p_tokens_out, 0), 'cost_micros', coalesce(p_cost_micros, 0)));
  RETURN gov._mandate_standing(r.mandate_id);
END
$$;
