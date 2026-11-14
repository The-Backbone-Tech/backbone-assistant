-- Having seen a channel account write, the system principal issues a one-time pairing link (by its
-- hash) that only a person completing it in their own session binds.
CREATE FUNCTION gov.request_pairing(p_account uuid, p_external_id text, p_link_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := gov._system('system_records');
  new_id uuid := gen_random_uuid();
BEGIN
  IF p_link_hash IS NULL OR p_link_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid: a pairing link is named by its hash';
  END IF;
  INSERT INTO app.channel_identities (workspace_id, id, account_id, external_id, link_hash)
  VALUES (sec.current_workspace(), new_id, p_account, p_external_id, p_link_hash);
  RETURN new_id;
END
$$;
