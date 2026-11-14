-- The ledger is append-only: an entry is never changed or removed.
CREATE FUNCTION sec.t_ledger_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  RAISE EXCEPTION 'frozen: the ledger is append-only (% refused)', lower(TG_OP);
END
$$;
