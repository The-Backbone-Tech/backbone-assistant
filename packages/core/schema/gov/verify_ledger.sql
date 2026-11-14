-- Verify the session workspace's ledger from its first entry: NULL when every entry chains, or the
-- seq of the first one that does not.
CREATE FUNCTION gov.verify_ledger() RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  e record;
  prev text := '';
  expected bigint := 1;
BEGIN
  IF sec.current_workspace() IS NULL THEN
    RAISE EXCEPTION 'no_identity: the session names no workspace';
  END IF;
  FOR e IN SELECT * FROM app.ledger WHERE workspace_id = sec.current_workspace() ORDER BY seq LOOP
    IF e.seq <> expected OR e.prev_hash <> prev
       OR e.hash <> sec.ledger_hash(e.prev_hash, e.workspace_id, e.seq, e.entry_type, e.actor_id, e.subject, e.payload, e.at) THEN
      RETURN e.seq;
    END IF;
    prev := e.hash;
    expected := expected + 1;
  END LOOP;
  RETURN NULL;
END
$$;
