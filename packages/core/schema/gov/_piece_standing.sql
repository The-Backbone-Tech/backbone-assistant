-- Whether what carries a run permits an effect: 'ok', or why not. Only a run of the recorded
-- 'direct' kind answers to its mandate alone; any other run, with no standing piece, permits nothing. The effective authority is the mandate's intersected with this:
-- an operation the piece did not declare, or a class above its highest declared one, is refused
-- whatever the mandate allows; an unregistered piece permits nothing.
CREATE FUNCTION gov._piece_standing(p_carrier text, p_piece uuid, p_operation text, p_class smallint) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  p record;
BEGIN
  IF p_carrier = 'direct' AND p_piece IS NULL THEN
    RETURN 'ok';
  END IF;
  IF p_carrier IS DISTINCT FROM 'piece' OR p_piece IS NULL THEN
    RETURN 'no_carrier';
  END IF;
  SELECT * INTO p FROM app.pieces x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_piece;
  IF NOT FOUND OR p.unregistered_at IS NOT NULL THEN
    RETURN 'piece_unregistered';
  END IF;
  IF NOT p.operations ? p_operation THEN
    RETURN 'outside_piece';
  END IF;
  IF p_class > p.effect_ceiling THEN
    RETURN 'above_piece_ceiling';
  END IF;
  RETURN 'ok';
END
$$;
