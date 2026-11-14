-- Columns named in the trigger's arguments never change once the row exists. Deleting is refused too.
CREATE FUNCTION sec.t_keep_columns() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  col text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'frozen: % rows are never deleted', TG_TABLE_NAME;
  END IF;
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF (to_jsonb(OLD) -> col) IS DISTINCT FROM (to_jsonb(NEW) -> col) THEN
      RAISE EXCEPTION 'frozen: %.% never changes', TG_TABLE_NAME, col;
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
