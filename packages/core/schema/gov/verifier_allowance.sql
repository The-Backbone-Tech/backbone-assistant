-- What the workspace's verifiers may still spend today.
CREATE FUNCTION gov.verifier_allowance() RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT greatest(w.verifier_allowance - coalesce((SELECT u.tokens FROM app.verifier_usage u
                                                   WHERE u.workspace_id = w.id AND u.day = (clock_timestamp() AT TIME ZONE 'UTC')::date), 0), 0)
  FROM app.workspaces w WHERE w.id = sec.current_workspace()
$$;
