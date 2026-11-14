-- Whether principal `p_me` may answer the question as a person (decision.answer), with this
-- verdict; refused with the reason otherwise. Who answers:
--   a question for a named person:   that person alone;
--   a question for any person:       an owner or admin, from outside the proposer's delegation
--                                    tree when the question is strict (in a team or company);
--   a verifier's question:           the verifier (verifier.answer, with its proof); in its place
--                                    the person named on it, or for an unnamed one an independent
--                                    owner or admin. A strict question's named person may decline
--                                    it but not approve it.
-- The proposer never answers its own question.
CREATE FUNCTION gov._may_answer(p_decision uuid, p_me uuid, p_verdict text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  d record;
  independent boolean;
BEGIN
  SELECT * INTO d FROM app.decisions x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_decision;
  IF NOT FOUND OR d.status <> 'open' THEN
    RAISE EXCEPTION 'not_open: the question is not open';
  END IF;
  IF p_me = d.proposer_id THEN
    RAISE EXCEPTION 'own_proposal: the proposer never answers its own question';
  END IF;
  independent := sec.workspace_is_personal(d.workspace_id) OR NOT d.is_strict
                 OR sec.checker_independent(d.workspace_id, d.proposer_id, p_me, true);
  IF d.checker_kind = 'verifier' THEN
    IF sec.is_verifier(p_me) THEN
      RAISE EXCEPTION 'verifier_proof: a verifier answers with its persisted response (verifier.answer)';
    END IF;
    IF sec.principal_kind(p_me) <> 'person' THEN
      RAISE EXCEPTION 'verifier_only: the question belongs to a verifier';
    END IF;
    IF d.checker_id IS NOT NULL THEN
      IF p_me <> d.checker_id THEN
        RAISE EXCEPTION 'verifier_only: the question belongs to the verifier and the person whose material it is';
      END IF;
      IF p_verdict = 'approved' AND NOT independent THEN
        RAISE EXCEPTION 'not_independent: the person may decline it, but approving it is the verifier''s';
      END IF;
      RETURN;
    END IF;
    IF NOT sec.is_admin(p_me) THEN
      RAISE EXCEPTION 'verifier_only: the question belongs to a verifier, or in its place an owner or admin';
    END IF;
    IF NOT independent THEN
      RAISE EXCEPTION 'not_independent: the checker sits in the proposer''s delegation tree';
    END IF;
    RETURN;
  END IF;
  IF d.checker_id IS NOT NULL THEN
    IF p_me <> d.checker_id THEN
      RAISE EXCEPTION 'someone_else: the question belongs to another person';
    END IF;
    RETURN;
  END IF;
  IF NOT sec.is_admin(p_me) THEN
    RAISE EXCEPTION 'role: an owner or an admin answers this question';
  END IF;
  IF NOT independent THEN
    RAISE EXCEPTION 'not_independent: the checker sits in the proposer''s delegation tree';
  END IF;
END
$$;
