-- Who the session acts as, for whom, and as which run.
CREATE FUNCTION gov.whoami() RETURNS TABLE (principal uuid, on_behalf_of uuid, run uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT sec.current_principal(), CASE WHEN sec.current_run() IS NOT NULL THEN sec.acting_for() END, sec.current_run()
$$;
