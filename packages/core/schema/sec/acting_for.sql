-- The person on whose behalf the session acts: a run's mandate beneficiary, a person themself, an
-- agent's owner. The system principal and a worker act for nobody.
CREATE FUNCTION sec.acting_for() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN sec.names_run() THEN (
      SELECT m.on_behalf_of_id FROM app.runs r
      JOIN app.mandates m ON m.workspace_id = r.workspace_id AND m.id = r.mandate_id
      WHERE r.workspace_id = sec.current_workspace() AND r.id = sec.current_run())
    ELSE (
      SELECT CASE p.kind WHEN 'person' THEN p.id WHEN 'agent' THEN o.id END
      FROM app.principals p
      LEFT JOIN app.principals o ON o.workspace_id = p.workspace_id AND o.id = p.owner_id AND o.kind = 'person'
      WHERE p.workspace_id = sec.current_workspace() AND p.id = sec.current_principal())
  END
$$;
