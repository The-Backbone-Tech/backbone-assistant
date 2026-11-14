-- The last entry of the session workspace's ledger, to be kept outside the database as an anchor.
CREATE FUNCTION gov.ledger_head() RETURNS TABLE (seq bigint, hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT l.seq, l.hash FROM app.ledger l WHERE l.workspace_id = sec.current_workspace() ORDER BY l.seq DESC LIMIT 1
$$;
