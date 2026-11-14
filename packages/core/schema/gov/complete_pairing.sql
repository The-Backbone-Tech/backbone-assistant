-- A person completes a pairing link in their own session: the channel account becomes theirs.
CREATE FUNCTION gov.complete_pairing(p_link_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := gov._person('not_by_runs');
  i record;
BEGIN
  SELECT * INTO i FROM app.channel_identities x WHERE x.workspace_id = sec.current_workspace() AND x.link_hash = p_link_hash AND x.person_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such pairing link';
  END IF;
  UPDATE app.channel_identities SET person_id = me, paired_at = clock_timestamp() WHERE workspace_id = i.workspace_id AND id = i.id;
  PERFORM gov._append('channel.paired', i.id::text, jsonb_build_object('person', me));
  RETURN i.id;
END
$$;
