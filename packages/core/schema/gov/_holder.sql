-- The session holds `p_run` at `p_fence`: it names the run with the secret of its current claim,
-- whatever the run's state. Otherwise refused as stale.
CREATE FUNCTION gov._holder(p_run uuid, p_fence bigint) RETURNS app.runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  r app.runs;
BEGIN
  -- Revocation takes workspace then run; holders must take the same order.
  PERFORM gov._lock_workspace();
  SELECT * INTO r FROM app.runs WHERE workspace_id = sec.current_workspace() AND id = p_run FOR UPDATE;
  IF NOT FOUND OR nullif(current_setting('backbone.run', true), '') IS DISTINCT FROM p_run::text
     OR (p_fence IS NOT NULL AND p_fence <> r.fence)
     OR NOT EXISTS (SELECT FROM ops.run_secrets s WHERE s.workspace_id = r.workspace_id AND s.run_id = r.id AND s.fence = r.fence
                    AND s.secret_hash = encode(sha256(convert_to(coalesce(current_setting('backbone.secret', true), ''), 'UTF8')), 'hex')) THEN
    RAISE EXCEPTION 'stale: the session does not hold this run at this fence';
  END IF;
  RETURN r;
END
$$;
