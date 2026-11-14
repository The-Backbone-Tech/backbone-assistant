-- Compatibility for Core clients that provision people directly. The shipped Host
-- uses invitations; every supported person-creation path takes the identity lock.
CREATE FUNCTION gov.identity_add_person(p_name text,p_email text,p_role text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('identity:'||sec.current_workspace()::text,17));
  PERFORM gov._lock_workspace();
  RETURN gov.add_person(p_name,p_email,p_role);
END
$$;
REVOKE ALL ON FUNCTION gov.identity_add_person(text,text,text) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_add_person(text,text,text) TO backbone_app;
