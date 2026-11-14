-- The session's principal as an owner or admin acting for themself, or refused (role).
CREATE FUNCTION gov._admin(p_in_run text DEFAULT 'role') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := gov._person(p_in_run);
BEGIN
  IF NOT sec.is_admin(me) THEN
    RAISE EXCEPTION 'role: only an owner or an admin does this';
  END IF;
  RETURN me;
END
$$;
