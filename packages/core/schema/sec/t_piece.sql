-- A registration's declaration never changes, and its ceiling is the highest class it declares. It
-- ends once, and is never deleted: runs bound to it keep pointing at what was registered.
CREATE FUNCTION sec.t_piece() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'frozen: piece registrations are never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.effect_ceiling := coalesce((SELECT max(c) FROM unnest(NEW.effect_classes) c), 0);
    RETURN NEW;
  END IF;
  IF OLD.unregistered_at IS NOT NULL AND (NEW.unregistered_at, NEW.unregistered_by) IS DISTINCT FROM (OLD.unregistered_at, OLD.unregistered_by) THEN
    RAISE EXCEPTION 'frozen: an unregistered piece stays unregistered';
  END IF;
  IF (NEW.id, NEW.workspace_id, NEW.piece, NEW.kind, NEW.version, NEW.digest, NEW.planes, NEW.operations, NEW.effect_classes,
      NEW.effect_ceiling, NEW.network, NEW.secrets, NEW.manifest, NEW.registered_by, NEW.registered_at)
     IS DISTINCT FROM
     (OLD.id, OLD.workspace_id, OLD.piece, OLD.kind, OLD.version, OLD.digest, OLD.planes, OLD.operations, OLD.effect_classes,
      OLD.effect_ceiling, OLD.network, OLD.secrets, OLD.manifest, OLD.registered_by, OLD.registered_at) THEN
    RAISE EXCEPTION 'frozen: a registered piece''s declaration never changes; register the new one';
  END IF;
  RETURN NEW;
END
$$;
