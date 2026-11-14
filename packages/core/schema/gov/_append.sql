-- Append one entry to the session workspace's ledger, chained to the last one. Entries carry
-- identifiers and keyed digests, never words. Holding the workspace's head row serialises every
-- crossing that records, so each sees what the one before it committed.
CREATE FUNCTION gov._append(p_type text, p_subject text, p_payload jsonb, p_actor uuid DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  head record;
  at timestamptz := clock_timestamp();
  actor uuid := coalesce(p_actor, sec.current_principal());
  payload jsonb := coalesce(p_payload, '{}');
  h text;
BEGIN
  SELECT * INTO head FROM app.ledger_heads WHERE workspace_id = ws FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no_identity: the session names no workspace';
  END IF;
  h := sec.ledger_hash(head.last_hash, ws, head.last_seq + 1, p_type, actor, p_subject, payload, at);
  INSERT INTO app.ledger (workspace_id, seq, entry_type, actor_id, subject, payload, at, prev_hash, hash)
  VALUES (ws, head.last_seq + 1, p_type, actor, p_subject, payload, at, head.last_hash, h);
  UPDATE app.ledger_heads SET last_seq = head.last_seq + 1, last_hash = h WHERE workspace_id = ws;
  RETURN head.last_seq + 1;
END
$$;
