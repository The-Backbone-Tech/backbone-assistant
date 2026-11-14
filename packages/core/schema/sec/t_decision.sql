-- An answered question stays answered. The question itself never changes, an approval comes from a
-- principal other than its proposer, and a strict question's approval from outside the proposer's
-- delegation tree (in a team or company workspace).
CREATE FUNCTION sec.t_decision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'frozen: questions are never deleted';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'frozen: an answered question stays answered';
  END IF;
  IF (NEW.subject_kind, NEW.subject_id, NEW.proposer_id, NEW.on_behalf_of_id, NEW.checker_kind, NEW.checker_id,
      NEW.reason, NEW.is_strict, NEW.proposal_hash, NEW.question, NEW.created_at)
     IS DISTINCT FROM
     (OLD.subject_kind, OLD.subject_id, OLD.proposer_id, OLD.on_behalf_of_id, OLD.checker_kind, OLD.checker_id,
      OLD.reason, OLD.is_strict, OLD.proposal_hash, OLD.question, OLD.created_at) THEN
    RAISE EXCEPTION 'frozen: a question never changes once asked';
  END IF;
  IF OLD.escalated_at IS NOT NULL AND (NEW.escalated_at, NEW.escalation_note) IS DISTINCT FROM (OLD.escalated_at, OLD.escalation_note) THEN
    RAISE EXCEPTION 'frozen: a question is escalated once';
  END IF;
  IF NEW.status = 'approved' THEN
    IF NEW.answered_by IS NULL OR NEW.answered_by = NEW.proposer_id THEN
      RAISE EXCEPTION 'not_independent: the proposer never approves its own question';
    END IF;
    IF NEW.is_strict AND NOT sec.workspace_is_personal(NEW.workspace_id)
       AND NOT sec.checker_independent(NEW.workspace_id, NEW.proposer_id, NEW.answered_by, true) THEN
      RAISE EXCEPTION 'not_independent: the checker sits in the proposer''s delegation tree';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
