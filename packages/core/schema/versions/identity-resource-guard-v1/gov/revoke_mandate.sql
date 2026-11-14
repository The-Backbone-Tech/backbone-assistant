-- Revoke a mandate and its whole delegation tree in one operation (I-3). Its runs stop
-- at once, effects not yet dispatched are cancelled and their questions withdrawn. Only its
-- grantor, the person it acts for, or an owner or admin revokes it. Returns how many were revoked.
CREATE OR REPLACE FUNCTION gov.revoke_mandate(p_mandate uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := sec.current_principal();
  m record;
  revoked uuid[];
  r record;
  e record;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no_identity: the session acts as nobody';
  END IF;
  SELECT * INTO m FROM app.mandates WHERE workspace_id = ws AND id = p_mandate;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such mandate in this workspace';
  END IF;
  IF me NOT IN (m.issuer_id, m.on_behalf_of_id) AND NOT (NOT sec.names_run() AND sec.is_admin(me)) THEN
    RAISE EXCEPTION 'role: only the grantor, the person it acts for, or an admin revokes a mandate';
  END IF;
  PERFORM gov._lock_workspace();
  SELECT array_agg(id) INTO revoked FROM app.mandates
  WHERE workspace_id = ws AND id IN (SELECT gov._subtree(p_mandate)) AND revoked_at IS NULL;
  IF revoked IS NULL THEN
    RETURN 0;
  END IF;
  UPDATE app.mandates SET revoked_at = clock_timestamp(), revoked_by = me WHERE workspace_id = ws AND id = ANY (revoked);
  PERFORM gov.identity_cancel_mandate_work(revoked,me);
  FOR r IN SELECT unnest(revoked) AS id LOOP
    PERFORM gov._append('mandate.revoked', r.id::text, jsonb_build_object('root', p_mandate));
  END LOOP;
  RETURN cardinality(revoked);
END
$$;
