-- A run is seen by whoever sees its task, and by a verifier asked about what it proposed.
CREATE FUNCTION sec.run_visible(p_run uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (SELECT FROM app.runs r WHERE r.workspace_id = sec.current_workspace() AND r.id = p_run AND sec.task_visible(r.task_id))
$$;
