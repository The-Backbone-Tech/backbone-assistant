-- A question is seen by the system principal, by the person whose work it is, by its named checker,
-- by verifiers when it is theirs, by any owner or admin when it is put to any of them, and by owners
-- and admins who may see its subject — except a rule-of-two question, which is only its person's
-- and the verifier's.
CREATE FUNCTION sec.decision_visible(p_decision uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT FROM app.decisions d
    WHERE d.workspace_id = sec.current_workspace() AND d.id = p_decision
      AND (sec.viewer() = sec.system_principal()
           OR sec.viewer() IN (d.on_behalf_of_id, d.checker_id, d.proposer_id)
           OR (d.checker_kind = 'verifier' AND sec.is_verifier(sec.current_principal()))
           OR (d.reason <> 'rule_of_two' AND sec.is_admin(sec.viewer()) AND (d.checker_id IS NULL OR CASE d.subject_kind
                 WHEN 'effect' THEN sec.effect_visible(d.subject_id)
                 WHEN 'promotion' THEN sec.candidate_visible(d.subject_id)
                 ELSE true END))))
$$;
