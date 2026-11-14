-- Evidence is immutable: a recorded source, a message, a kept document version, a verifier's proof.
-- Rows are added, never changed or removed, whoever writes.
CREATE FUNCTION sec.t_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  RAISE EXCEPTION 'frozen: evidence is immutable (% on %)', lower(TG_OP), TG_TABLE_NAME;
END
$$;
