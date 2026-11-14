-- Whether the ledger still holds an anchor kept outside it: the entry at `p_seq`, with that hash,
-- in a chain that verifies.
CREATE FUNCTION gov.verify_ledger_anchor(p_seq bigint, p_hash text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (SELECT FROM app.ledger l WHERE l.workspace_id = sec.current_workspace() AND l.seq = p_seq AND l.hash = p_hash)
     AND coalesce(gov.verify_ledger() > p_seq, true)
$$;
