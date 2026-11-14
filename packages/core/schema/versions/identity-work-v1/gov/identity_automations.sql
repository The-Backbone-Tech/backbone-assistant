-- Explicit project/directory/automation authority; never inferred from a renderer's identity.
CREATE FUNCTION gov.identity_automations() RETURNS TABLE(id uuid, name text, person uuid, project uuid, mandate uuid, piece uuid, revoked boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  PERFORM gov._admin();
  RETURN QUERY SELECT a.id,a.name,a.owner_id,(m.intent->>'project')::uuid,m.id,m.piece_id,m.revoked_at IS NOT NULL OR m.expires_at<=clock_timestamp() OR p.status<>'active'
  FROM app.principals a JOIN app.mandates m ON m.workspace_id=a.workspace_id AND m.subject_id=a.id JOIN app.principals p ON p.workspace_id=a.workspace_id AND p.id=a.owner_id
  WHERE a.workspace_id=sec.current_workspace() AND a.kind='agent' AND m.intent->>'identityAutomation'='true' ORDER BY a.created_at,a.id;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_automations() FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_automations() TO backbone_app;
