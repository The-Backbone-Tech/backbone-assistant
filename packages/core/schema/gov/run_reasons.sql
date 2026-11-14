-- Why a run is marked, in plain words. Read by its person, by the system principal and by whoever
-- decides a question about what it proposed (its named checker, or a verifier); by nobody else.
CREATE FUNCTION gov.run_reasons(p_run uuid) RETURNS TABLE (untrusted text, sensitive text, elsewhere text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT r.untrusted_source, r.sensitive_source, r.elsewhere_source FROM app.runs r
  WHERE r.workspace_id = sec.current_workspace() AND r.id = p_run AND sec.current_principal() IS NOT NULL
    AND (gov._run_person(r.id) = sec.viewer()
         OR sec.viewer() = sec.system_principal()
         OR EXISTS (SELECT FROM app.effects e JOIN app.decisions d ON d.workspace_id = e.workspace_id AND d.id = e.decision_id
                    WHERE e.workspace_id = r.workspace_id AND e.run_id = r.id
                      AND (d.checker_id = sec.viewer() OR (d.checker_kind = 'verifier' AND sec.is_verifier(sec.current_principal())))))
$$;
