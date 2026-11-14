-- A step's input is frozen when written, and a completed step never changes.
CREATE FUNCTION sec.t_step() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'frozen: steps are never deleted';
  END IF;
  IF OLD.status = 'done' THEN
    RAISE EXCEPTION 'frozen: a completed step never changes';
  END IF;
  IF NEW.input IS DISTINCT FROM OLD.input OR NEW.seq <> OLD.seq OR NEW.run_id <> OLD.run_id
     OR NEW.fence <> OLD.fence OR NEW.kind <> OLD.kind OR NEW.title IS DISTINCT FROM OLD.title THEN
    RAISE EXCEPTION 'frozen: a step''s input is frozen when it is written';
  END IF;
  RETURN NEW;
END
$$;
