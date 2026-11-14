-- Independently attested current-facts admission while unrelated Team checks pause.
CREATE FUNCTION operator.identity_device_only(p_person uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE ws uuid:=sec.current_workspace();
BEGIN
 IF session_user<>'backbone_operator' OR sec.current_run() IS NOT NULL THEN RAISE EXCEPTION 'denied: device operator only'; END IF;
 RETURN EXISTS(SELECT FROM app.ledger WHERE workspace_id=ws AND entry_type='workspace.created' AND actor_id=p_person AND payload->>'owner'=p_person::text)
  AND EXISTS(SELECT FROM app.principals WHERE workspace_id=ws AND id=p_person AND kind='person' AND status='active' AND role='owner')
  AND NOT EXISTS(SELECT FROM app.principals WHERE workspace_id=ws AND kind='person' AND id<>p_person AND status='active')
  AND NOT EXISTS(SELECT FROM app.identity_sessions WHERE workspace_id=ws AND principal_id<>p_person AND revoked_at IS NULL AND expires_at>clock_timestamp())
  AND NOT EXISTS(SELECT FROM app.principals a JOIN app.mandates m ON m.workspace_id=a.workspace_id AND m.subject_id=a.id
    WHERE a.workspace_id=ws AND a.kind='agent' AND a.owner_id<>p_person AND a.status='active'
    AND m.intent->>'identityAutomation'='true' AND m.revoked_at IS NULL AND m.expires_at>clock_timestamp());
END
$$;
REVOKE ALL ON FUNCTION operator.identity_device_only(uuid) FROM PUBLIC,backbone_app;
GRANT EXECUTE ON FUNCTION operator.identity_device_only(uuid) TO backbone_operator;
