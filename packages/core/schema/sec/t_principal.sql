-- A principal keeps its workspace, kind and owner; its bound account never changes once bound.
CREATE FUNCTION sec.t_principal() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'frozen: principals are never deleted';
  END IF;
  IF OLD.user_id IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'frozen: a person''s bound account never changes';
  END IF;
  IF (NEW.id, NEW.workspace_id, NEW.kind, NEW.agent_role, NEW.owner_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.kind, OLD.agent_role, OLD.owner_id, OLD.created_at) THEN
    RAISE EXCEPTION 'frozen: a principal keeps its workspace, kind and owner';
  END IF;
  RETURN NEW;
END
$$;
