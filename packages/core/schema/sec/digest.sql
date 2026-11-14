-- A keyed digest of words someone wrote, under the session workspace's own key (kept in ops, which
-- the service cannot read). The ledger records this in place of the words: whoever has the words
-- cannot test them against the ledger by hashing them, and another workspace digests them apart.
CREATE FUNCTION sec.digest(p_words text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN p_words IS NULL THEN NULL ELSE
    encode(crypto.hmac(convert_to(p_words, 'UTF8'),
                       (SELECT digest_key FROM ops.workspace_keys WHERE workspace_id = sec.current_workspace()), 'sha256'), 'hex')
  END
$$;
