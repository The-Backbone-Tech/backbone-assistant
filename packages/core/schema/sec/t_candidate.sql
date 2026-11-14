-- A knowledge candidate's claim never changes, its terms are set once, its marks never flip, and a
-- closed candidate stays closed.
CREATE FUNCTION sec.t_candidate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'frozen: candidates are never deleted';
  END IF;
  IF (NEW.id, NEW.workspace_id, NEW.statement, NEW.topic, NEW.evidence, NEW.proposed_by, NEW.run_id, NEW.on_behalf_of,
      NEW.words_untrusted, NEW.kept, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.statement, OLD.topic, OLD.evidence, OLD.proposed_by, OLD.run_id,
      OLD.on_behalf_of, OLD.words_untrusted, OLD.kept, OLD.created_at) THEN
    RAISE EXCEPTION 'frozen: a candidate''s claim and marks never change';
  END IF;
  IF OLD.terms_hash IS NOT NULL AND (NEW.owner_id, NEW.valid_from, NEW.valid_to, NEW.terms_hash)
     IS DISTINCT FROM (OLD.owner_id, OLD.valid_from, OLD.valid_to, OLD.terms_hash) THEN
    RAISE EXCEPTION 'frozen: a candidate''s terms are set once';
  END IF;
  IF OLD.terms_hash IS NULL AND OLD.owner_id IS NOT NULL AND NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'frozen: a candidate''s terms are set once';
  END IF;
  IF OLD.status <> 'open' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'frozen: a closed candidate stays closed';
  END IF;
  RETURN NEW;
END
$$;
