-- No store is ever truncated, not even by the role that owns it.
CREATE FUNCTION sec.t_refuse_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  RAISE EXCEPTION 'frozen: %.% is never truncated', TG_TABLE_SCHEMA, TG_TABLE_NAME;
END
$$;
