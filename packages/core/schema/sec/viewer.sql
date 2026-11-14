-- Whose eyes a read uses: the person the session acts for, or the system principal itself.
-- A verifier, or a worker that names no principal, is nobody's: it reads only what is everyone's
-- and what its own questions show it.
CREATE FUNCTION sec.viewer() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN sec.current_principal() = sec.system_principal() THEN sec.system_principal() ELSE sec.acting_for() END
$$;
