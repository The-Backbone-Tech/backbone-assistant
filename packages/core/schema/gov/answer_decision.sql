-- A person answers a question, bound to the exact proposal they were shown (its hash). The first
-- valid answer wins; a run answers nothing (I-4).
CREATE FUNCTION gov.answer_decision(p_decision uuid, p_proposal_hash text, p_verdict text, p_note text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := sec.current_principal();
  d record;
BEGIN
  IF sec.names_run() THEN
    RAISE EXCEPTION 'not_by_runs: a question is never answered from inside a run';
  END IF;
  IF me IS NULL THEN
    RAISE EXCEPTION 'no_identity: the session acts as nobody';
  END IF;
  PERFORM gov._lock_workspace();
  SELECT * INTO d FROM app.decisions x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_decision FOR UPDATE;
  IF NOT FOUND OR d.status <> 'open' THEN
    RAISE EXCEPTION 'not_open: the question is not open';
  END IF;
  IF p_proposal_hash IS DISTINCT FROM d.proposal_hash THEN
    RAISE EXCEPTION 'different_proposal: the answer names another proposal than the one asked';
  END IF;
  IF p_verdict IS NULL OR p_verdict NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'invalid: a verdict is approved or rejected';
  END IF;
  PERFORM gov._may_answer(p_decision, me, p_verdict);
  PERFORM gov._settle_decision(p_decision, p_verdict, me, p_note);
  RETURN p_verdict;
END
$$;
