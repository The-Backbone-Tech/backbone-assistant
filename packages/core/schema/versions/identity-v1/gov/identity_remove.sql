-- Identity operations serialize admission and revocation before observing authority.
CREATE FUNCTION gov.identity_remove(p_person uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE me uuid; target record; m record; ws uuid:=sec.current_workspace();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('identity:'||ws::text,17));
  PERFORM gov._lock_workspace(); me:=gov._admin();
  SELECT * INTO target FROM app.principals WHERE workspace_id=ws AND id=p_person AND kind='person' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found: no person'; END IF;
  IF target.role='owner' AND (sec.role_of(me)<>'owner' OR NOT EXISTS(SELECT FROM app.principals WHERE workspace_id=ws AND kind='person' AND role='owner' AND status='active' AND id<>p_person)) THEN
    RAISE EXCEPTION 'role: keep a live owner';
  END IF;
  IF target.status='removed' THEN RETURN p_person; END IF;
  FOR m IN SELECT id FROM app.mandates WHERE workspace_id=ws AND revoked_at IS NULL AND (on_behalf_of_id=p_person OR issuer_id=p_person OR subject_id IN (SELECT id FROM app.principals WHERE workspace_id=ws AND owner_id=p_person)) ORDER BY created_at,id LOOP
    PERFORM gov.revoke_mandate(m.id);
  END LOOP;
  UPDATE app.identity_sessions SET revoked_at=clock_timestamp() WHERE workspace_id=ws AND principal_id=p_person AND revoked_at IS NULL;
  UPDATE app.identity_invitations SET expires_at=least(expires_at,clock_timestamp()) WHERE workspace_id=ws AND invited_by=p_person AND accepted_by IS NULL;
  UPDATE app.principals SET status='removed' WHERE workspace_id=ws AND (id=p_person OR owner_id=p_person);
  PERFORM gov._append('identity.removed',p_person::text,'{}',me);
  RETURN p_person;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_remove(uuid) FROM PUBLIC, backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_remove(uuid) TO backbone_app;

