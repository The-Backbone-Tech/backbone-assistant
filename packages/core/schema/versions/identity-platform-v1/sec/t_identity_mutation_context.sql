-- A statement without a live actor must refuse even when project RLS hides all
-- target rows. Row immutability triggers still check every admitted mutation.
CREATE FUNCTION sec.t_identity_mutation_context() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog
AS $$
BEGIN
  -- The installer can disable storage enforcement to inspect a corrupted ledger.
  -- Service and owner roles retain the native frozen refusal before RLS filtering.
  IF NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user)
    AND sec.current_principal() IS NULL THEN
    RAISE EXCEPTION 'frozen: permission denied: mutation requires a live actor';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION sec.t_identity_mutation_context() FROM PUBLIC,backbone_app,backbone_operator;
GRANT EXECUTE ON FUNCTION sec.t_identity_mutation_context() TO backbone_owner;
