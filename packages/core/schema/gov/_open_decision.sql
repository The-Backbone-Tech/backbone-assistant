-- Ask a question once, at the crossing. A verifier's question also enters the verification queue
-- when the workspace has a verifier.
CREATE FUNCTION gov._open_decision(
  p_subject_kind text, p_subject uuid, p_proposer uuid, p_on_behalf_of uuid, p_reason text, p_proposal_hash text,
  p_question text, p_strict boolean, p_checker_kind text, p_checker uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  new_id uuid := gen_random_uuid();
  verifier uuid;
BEGIN
  IF EXISTS (SELECT FROM app.decisions d WHERE d.workspace_id = ws AND d.subject_id = p_subject AND d.status = 'open') THEN
    RAISE EXCEPTION 'conflict: there is already an open question about this';
  END IF;
  INSERT INTO app.decisions (workspace_id, id, subject_kind, subject_id, proposer_id, on_behalf_of_id, checker_kind, checker_id,
                             reason, is_strict, proposal_hash, question)
  VALUES (ws, new_id, p_subject_kind, p_subject, p_proposer, p_on_behalf_of, p_checker_kind, p_checker, p_reason,
          p_strict, p_proposal_hash, coalesce(p_question, ''));
  IF p_checker_kind = 'verifier' THEN
    SELECT p.id INTO verifier FROM app.principals p
    WHERE p.workspace_id = ws AND p.kind = 'agent' AND p.agent_role = 'verifier' AND p.status = 'active'
    ORDER BY p.created_at LIMIT 1;
    IF verifier IS NOT NULL THEN
      INSERT INTO ops.verification_queue (decision_id, workspace_id, verifier_id) VALUES (new_id, ws, verifier);
    END IF;
  END IF;
  PERFORM gov._append('decision.asked', new_id::text, jsonb_build_object(
    'subject_kind', p_subject_kind, 'subject', p_subject, 'reason', p_reason, 'checker_kind', p_checker_kind,
    'checker', p_checker, 'proposal_hash', p_proposal_hash));
  RETURN new_id;
END
$$;
