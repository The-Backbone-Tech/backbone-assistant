-- Explicit project/directory/automation authority; never inferred from a renderer's identity.
CREATE FUNCTION gov.identity_automation_revoke(p_agent uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE me uuid; m record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('identity:'||sec.current_workspace()::text,17)); PERFORM gov._lock_workspace(); me:=gov._admin();
  IF NOT EXISTS(SELECT FROM app.mandates WHERE workspace_id=sec.current_workspace() AND subject_id=p_agent AND intent->>'identityAutomation'='true') THEN RAISE EXCEPTION 'not_found: no automation'; END IF;
  FOR m IN SELECT id FROM app.mandates WHERE workspace_id=sec.current_workspace() AND subject_id=p_agent AND revoked_at IS NULL LOOP PERFORM gov.revoke_mandate(m.id); END LOOP;
  PERFORM gov._append('identity.automation_revoked',p_agent::text,'{}',me);
  RETURN p_agent;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_automation_revoke(uuid) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_automation_revoke(uuid) TO backbone_app;
