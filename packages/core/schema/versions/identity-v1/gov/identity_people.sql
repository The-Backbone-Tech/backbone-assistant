-- Identity operations serialize admission and revocation before observing authority.
CREATE FUNCTION gov.identity_people() RETURNS TABLE(id uuid, name text, role text, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  PERFORM gov._admin();
  RETURN QUERY SELECT p.id,p.name,p.role,p.status FROM app.principals p WHERE p.workspace_id=sec.current_workspace() AND p.kind='person' ORDER BY p.created_at,p.id;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_people() FROM PUBLIC, backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_people() TO backbone_app;

