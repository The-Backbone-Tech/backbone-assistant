-- One ledger entry's hash: SHA-256 over the previous entry's hash and the entry's own fields, in a
-- canonical jsonb text. Changing any field, or the order, breaks the chain at that entry.
CREATE FUNCTION sec.ledger_hash(
  p_prev text, p_workspace uuid, p_seq bigint, p_type text, p_actor uuid, p_subject text, p_payload jsonb, p_at timestamptz
) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$
  SELECT encode(sha256(convert_to(p_prev || '|' || jsonb_build_object(
    'workspace', p_workspace, 'seq', p_seq, 'type', p_type, 'actor', p_actor, 'subject', p_subject,
    'payload', p_payload, 'at', to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text, 'UTF8')), 'hex')
$$;
