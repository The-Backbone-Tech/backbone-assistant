-- A mandate's terms never change; revocation is final; a child never exceeds its parent, and is
-- never issued under a revoked one. The intent hash is the hash of exactly the stated intent. A
-- mandate granted to a piece names a standing registration, and its children stay with that piece.
CREATE FUNCTION sec.t_mandate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  p record;
  binding text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'frozen: mandates are never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.intent_hash := sec.args_hash(NEW.intent);
    IF NEW.parent_id IS NOT NULL THEN
      SELECT * INTO p FROM app.mandates WHERE workspace_id = NEW.workspace_id AND id = NEW.parent_id;
      IF FOUND AND p.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'revoked: the parent mandate is revoked';
      END IF;
      IF FOUND AND (NEW.carrier, NEW.piece_id) IS DISTINCT FROM (p.carrier, p.piece_id) THEN
        RAISE EXCEPTION 'other_piece: a child mandate stays with what carries its parent''s work';
      END IF;
      IF FOUND AND NOT sec.terms_within(sec.mandate_terms(to_jsonb(NEW)), sec.mandate_terms(to_jsonb(p))) THEN
        RAISE EXCEPTION 'exceeds_parent: a child mandate never exceeds its parent';
      END IF;
    END IF;
    IF NEW.piece_id IS NOT NULL THEN
      binding := sec.piece_binding(NEW.piece_id);
      IF binding = 'not_registered' THEN
        RAISE EXCEPTION 'not_registered: the piece is not registered in this workspace';
      ELSIF binding <> 'ok' THEN
        RAISE EXCEPTION 'denied: the piece does not declare this workspace''s plane';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at, NEW.revoked_by) IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by) THEN
    RAISE EXCEPTION 'frozen: a revoked mandate stays revoked';
  END IF;
  IF sec.mandate_terms(to_jsonb(NEW)) IS DISTINCT FROM sec.mandate_terms(to_jsonb(OLD))
     OR (NEW.id, NEW.workspace_id, NEW.issuer_id, NEW.subject_id, NEW.on_behalf_of_id, NEW.parent_id, NEW.intent, NEW.intent_hash, NEW.carrier, NEW.piece_id, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.issuer_id, OLD.subject_id, OLD.on_behalf_of_id, OLD.parent_id, OLD.intent, OLD.intent_hash, OLD.carrier, OLD.piece_id, OLD.created_at) THEN
    RAISE EXCEPTION 'frozen: a mandate''s terms never change';
  END IF;
  RETURN NEW;
END
$$;
