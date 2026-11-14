-- Identity operations serialize admission and revocation before observing authority.
CREATE FUNCTION gov.identity_change_role(p_person uuid, p_role text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE me uuid; old text; m record; ws uuid:=sec.current_workspace();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('identity:'||ws::text,17));
  PERFORM gov._lock_workspace(); me:=gov._admin(); old:=sec.role_of(p_person);
  IF old='owner' AND p_role<>'owner' AND NOT EXISTS(SELECT FROM app.principals WHERE workspace_id=ws AND kind='person' AND role='owner' AND status='active' AND id<>p_person) THEN RAISE EXCEPTION 'role: keep a live owner'; END IF;
  PERFORM gov.change_role(p_person,p_role);
  IF p_role='guest' THEN
    FOR m IN SELECT id FROM app.mandates WHERE workspace_id=ws AND on_behalf_of_id=p_person AND revoked_at IS NULL LOOP PERFORM gov.revoke_mandate(m.id); END LOOP;
  END IF;
  RETURN p_role;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_change_role(uuid,text) FROM PUBLIC, backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_change_role(uuid,text) TO backbone_app;

