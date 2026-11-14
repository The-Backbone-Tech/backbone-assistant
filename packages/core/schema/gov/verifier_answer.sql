-- A verifier answers a verifier's question. Its answer is persisted first, bound to the exact
-- proposal (the proof a raw answer lacks), then carried out. A question another verifier worker
-- holds under a live lease waits for that lease to lapse.
CREATE FUNCTION gov.verifier_answer(p_decision uuid, p_verdict text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := sec.current_principal();
  d record;
  q record;
BEGIN
  IF me IS NULL OR sec.names_run() OR NOT sec.is_verifier(me) THEN
    RAISE EXCEPTION 'role: only a verifier answers this way';
  END IF;
  PERFORM gov._lock_workspace();
  SELECT * INTO d FROM app.decisions x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_decision FOR UPDATE;
  IF NOT FOUND OR d.status <> 'open' THEN
    RAISE EXCEPTION 'not_open: the question is not open';
  END IF;
  IF d.checker_kind <> 'verifier' THEN
    RAISE EXCEPTION 'role: the question is not a verifier''s';
  END IF;
  IF p_verdict IS NULL OR p_verdict NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'invalid: a verdict is approved or rejected';
  END IF;
  SELECT * INTO q FROM ops.verification_queue x WHERE x.decision_id = p_decision;
  IF FOUND AND q.worker IS NOT NULL AND q.available_at > clock_timestamp() THEN
    RAISE EXCEPTION 'not_claimable: another verifier worker holds the question';
  END IF;
  IF NOT sec.checker_independent(d.workspace_id, d.proposer_id, me, true) THEN
    RAISE EXCEPTION 'not_independent: the verifier sits in the proposer''s delegation tree';
  END IF;
  INSERT INTO app.verifications (workspace_id, decision_id, verifier_id, proposal_hash, verdict, reason, response_hash)
  VALUES (d.workspace_id, p_decision, me, d.proposal_hash, p_verdict, coalesce(p_reason, ''),
          sec.args_hash(jsonb_build_object('decision', p_decision, 'proposal', d.proposal_hash, 'verdict', p_verdict, 'reason', coalesce(p_reason, ''))));
  PERFORM gov._settle_decision(p_decision, p_verdict, me, p_reason);
  RETURN p_verdict;
END
$$;
