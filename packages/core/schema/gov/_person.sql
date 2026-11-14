-- The session's principal as a person acting for themself: a person, outside any run. Otherwise
-- refused: nobody → no_identity, a run → p_in_run, anyone else → role.
CREATE FUNCTION gov._person(p_in_run text DEFAULT 'role') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := sec.current_principal();
BEGIN
  IF sec.names_run() AND me IS NOT NULL THEN
    RAISE EXCEPTION '%: this is not done from inside a run', p_in_run;
  END IF;
  IF me IS NULL THEN
    RAISE EXCEPTION 'no_identity: the session acts as nobody';
  END IF;
  IF sec.principal_kind(me) <> 'person' THEN
    RAISE EXCEPTION 'role: only a person does this';
  END IF;
  RETURN me;
END
$$;
