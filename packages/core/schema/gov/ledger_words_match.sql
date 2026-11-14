-- Whether given words are the ones a ledger entry names by digest (SG-LED-01), for an owner or
-- admin, without revealing the workspace's key: true, false, or NULL when the entry has no digest
-- under that field.
CREATE FUNCTION gov.ledger_words_match(p_seq bigint, p_field text, p_words text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  digest text;
BEGIN
  PERFORM gov._admin('not_by_runs');
  SELECT l.payload ->> p_field INTO digest FROM app.ledger l WHERE l.workspace_id = sec.current_workspace() AND l.seq = p_seq;
  IF digest IS NULL OR digest !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;
  RETURN digest = sec.digest(p_words);
END
$$;
