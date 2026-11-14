-- Explicit project/directory/automation authority; never inferred from a renderer's identity.
CREATE FUNCTION gov.identity_directory_list(p_issuer text) RETURNS TABLE(id uuid, username text, external_id text, display_name text, active boolean, revision bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  PERFORM gov._admin();
  RETURN QUERY SELECT p.id,d.user_name,d.subject,d.display_name,p.status='active',d.revision
  FROM app.identity_directory d JOIN app.principals p ON p.workspace_id=d.workspace_id AND p.id=d.principal_id
  WHERE d.workspace_id=sec.current_workspace() AND d.issuer=p_issuer ORDER BY p.id;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_directory_list(text) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_directory_list(text) TO backbone_app;
