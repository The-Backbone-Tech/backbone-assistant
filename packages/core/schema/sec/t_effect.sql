-- An effect row only moves forward. Its hash matches its arguments; what was proposed, under which
-- authority and with which lineage never changes; it is never deleted. Only the gateway writes it,
-- and these rules hold even for a writer below every grant.
CREATE FUNCTION sec.t_effect() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'frozen: effects are never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.args_hash IS DISTINCT FROM sec.args_hash(NEW.args) THEN
      RAISE EXCEPTION 'invalid: the effect''s hash does not match its arguments';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.workspace_id, NEW.run_id, NEW.task_id, NEW.step_seq, NEW.proposer_id, NEW.on_behalf_of_id, NEW.mandate_id,
      NEW.tool, NEW.operation, NEW.connection, NEW.connection_id, NEW.project, NEW.effect_class, NEW.external_party,
      NEW.args, NEW.args_hash, NEW.description, NEW.expected_version, NEW.idempotency_key, NEW.route, NEW.route_reason,
      NEW.undo_of, NEW.repeat_of, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.workspace_id, OLD.run_id, OLD.task_id, OLD.step_seq, OLD.proposer_id, OLD.on_behalf_of_id, OLD.mandate_id,
      OLD.tool, OLD.operation, OLD.connection, OLD.connection_id, OLD.project, OLD.effect_class, OLD.external_party,
      OLD.args, OLD.args_hash, OLD.description, OLD.expected_version, OLD.idempotency_key, OLD.route, OLD.route_reason,
      OLD.undo_of, OLD.repeat_of, OLD.created_at) THEN
    RAISE EXCEPTION 'frozen: a proposed effect is never altered';
  END IF;
  IF OLD.decision_id IS NOT NULL AND NEW.decision_id IS DISTINCT FROM OLD.decision_id THEN
    RAISE EXCEPTION 'frozen: an effect''s question never changes';
  END IF;
  IF NEW.status <> OLD.status AND NOT sec.effect_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'frozen: an effect only moves forward (% to % refused)', OLD.status, NEW.status;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;
