-- The exact question is a capability, including an independent checker for
-- an unnamed elevation. A role alone still grants no other project's payloads.
CREATE OR REPLACE FUNCTION gov.identity_effect_decider_access(p_decision uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
  SELECT NOT sec.names_run() AND sec.current_principal() IS NOT NULL AND EXISTS(
    SELECT FROM app.decisions d WHERE d.workspace_id=sec.current_workspace() AND d.id=p_decision
      AND (d.checker_id=sec.viewer() OR d.answered_by=sec.current_principal()
        OR (d.checker_kind='verifier' AND sec.is_verifier(sec.current_principal()))
        OR (d.subject_kind='effect' AND gov.may_decide(d.id))))
$$;
