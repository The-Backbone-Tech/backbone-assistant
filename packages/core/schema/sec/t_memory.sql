-- Memory stays with its person: never reassigned. Forgetting erases the content and is final.
CREATE FUNCTION sec.t_memory() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'frozen: memory is forgotten, never deleted';
  END IF;
  IF (NEW.id, NEW.workspace_id, NEW.owner_id, NEW.agent_id, NEW.words_untrusted, NEW.run_id, NEW.step_seq, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.owner_id, OLD.agent_id, OLD.words_untrusted, OLD.run_id, OLD.step_seq, OLD.created_at) THEN
    RAISE EXCEPTION 'frozen: memory is never reassigned';
  END IF;
  IF OLD.forgotten_at IS NOT NULL THEN
    RAISE EXCEPTION 'frozen: forgotten memory stays forgotten';
  END IF;
  IF NEW.content IS DISTINCT FROM OLD.content AND (NEW.forgotten_at IS NULL OR NEW.content <> '') THEN
    RAISE EXCEPTION 'frozen: memory changes only by being forgotten';
  END IF;
  IF NEW.forgotten_at IS NOT NULL AND NEW.content <> '' THEN
    RAISE EXCEPTION 'frozen: forgetting erases the content';
  END IF;
  RETURN NEW;
END
$$;
