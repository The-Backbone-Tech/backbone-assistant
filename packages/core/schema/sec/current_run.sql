-- The run the session acts as: named, running, held with the secret of its current claim, under a
-- mandate that is neither revoked nor expired. Anything less is no run at all.
CREATE FUNCTION sec.current_run() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT r.id
  FROM app.runs r
  JOIN ops.run_secrets s ON s.workspace_id = r.workspace_id AND s.run_id = r.id AND s.fence = r.fence
  JOIN app.mandates m ON m.workspace_id = r.workspace_id AND m.id = r.mandate_id
  WHERE r.workspace_id = sec.current_workspace()
    AND r.id = nullif(current_setting('backbone.run', true), '')::uuid
    AND r.status = 'running'
    AND s.secret_hash = encode(sha256(convert_to(coalesce(current_setting('backbone.secret', true), ''), 'UTF8')), 'hex')
    AND m.revoked_at IS NULL
    AND m.expires_at > clock_timestamp()
$$;
