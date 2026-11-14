-- A run takes its mandate's carrier (a registered piece, or 'direct') when it is queued, and never
-- changes it. A run under a piece's mandate is bound to that piece (it may name none, and inherits
-- it); a direct mandate never carries a piece's run.
CREATE FUNCTION sec.t_run_piece() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  m record;
  binding text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.carrier, NEW.piece_id) IS DISTINCT FROM (OLD.carrier, OLD.piece_id) THEN
      RAISE EXCEPTION 'frozen: a run keeps what carries it';
    END IF;
    RETURN NEW;
  END IF;
  SELECT x.carrier, x.piece_id INTO m FROM app.mandates x WHERE x.workspace_id = NEW.workspace_id AND x.id = NEW.mandate_id;
  IF NEW.piece_id IS NOT NULL AND NEW.piece_id IS DISTINCT FROM m.piece_id THEN
    RAISE EXCEPTION 'other_piece: the run''s mandate was granted to another piece, or to none';
  END IF;
  NEW.carrier := m.carrier;
  NEW.piece_id := m.piece_id;
  IF NEW.piece_id IS NOT NULL THEN
    binding := sec.piece_binding(NEW.piece_id);
    IF binding = 'not_registered' THEN
      RAISE EXCEPTION 'not_registered: the piece is not registered in this workspace';
    ELSIF binding <> 'ok' THEN
      RAISE EXCEPTION 'denied: the piece does not declare this workspace''s plane';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
