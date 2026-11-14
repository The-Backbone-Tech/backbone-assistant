-- Accepted knowledge is never rewritten in place; it is retracted once, with its reason.
CREATE FUNCTION sec.t_knowledge() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'frozen: knowledge is never deleted';
  END IF;
  IF (NEW.id, NEW.workspace_id, NEW.candidate_id, NEW.decision_id, NEW.statement, NEW.topic, NEW.owner_id,
      NEW.valid_from, NEW.valid_to, NEW.words_untrusted, NEW.accepted_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.candidate_id, OLD.decision_id, OLD.statement, OLD.topic, OLD.owner_id,
      OLD.valid_from, OLD.valid_to, OLD.words_untrusted, OLD.accepted_by, OLD.created_at) THEN
    RAISE EXCEPTION 'frozen: accepted knowledge is never rewritten in place';
  END IF;
  IF OLD.status = 'retracted' THEN
    RAISE EXCEPTION 'frozen: retracted knowledge stays retracted';
  END IF;
  RETURN NEW;
END
$$;
