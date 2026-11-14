-- The person a run works for: its mandate's beneficiary.
CREATE FUNCTION gov._run_person(p_run uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT m.on_behalf_of_id FROM app.runs r JOIN app.mandates m ON m.workspace_id = r.workspace_id AND m.id = r.mandate_id
  WHERE r.workspace_id = sec.current_workspace() AND r.id = p_run
$$;
