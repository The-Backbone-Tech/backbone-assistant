-- A verifier hands a question on to people, once, saying why. The question stays open, leaves the
-- verification queue, and its note stays with the question: the ledger records only its digest.
CREATE FUNCTION gov.escalate_decision(p_decision uuid, p_note text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := sec.current_principal();
  d record;
BEGIN
  IF me IS NULL OR NOT sec.is_verifier(me) OR sec.names_run() THEN
    RAISE EXCEPTION 'role: only a verifier escalates a question';
  END IF;
  SELECT * INTO d FROM app.decisions x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_decision FOR UPDATE;
  IF NOT FOUND OR d.status <> 'open' OR d.escalated_at IS NOT NULL THEN
    RAISE EXCEPTION 'not_open: the question is not open to escalation';
  END IF;
  IF d.checker_kind <> 'verifier' THEN
    RAISE EXCEPTION 'role: the question is not a verifier''s';
  END IF;
  UPDATE app.decisions SET escalation_note = coalesce(p_note, ''), escalated_at = clock_timestamp()
  WHERE workspace_id = d.workspace_id AND id = p_decision;
  DELETE FROM ops.verification_queue x WHERE x.decision_id = p_decision;
  PERFORM gov._append('decision.escalated', p_decision::text, jsonb_build_object('note', sec.digest(p_note)));
  RETURN p_decision;
END
$$;
