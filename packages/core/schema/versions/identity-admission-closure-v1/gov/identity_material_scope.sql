-- NULL is an explicit workspace material scope, not an unbound task. Only
-- live people and verifiers can read it; guests/verifiers cannot write it.
-- Task checks stay closed, including orphan tasks and unnamed sessions.
GRANT USAGE ON SCHEMA gov TO backbone_owner;
CREATE FUNCTION gov.identity_material_scope(p_task uuid,p_write boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE principal uuid:=sec.current_principal(); role text;
BEGIN
  IF p_task IS NOT NULL THEN RETURN gov.identity_task_access(p_task,p_write); END IF;
  IF principal=sec.system_principal() THEN RETURN true; END IF;
  IF principal IS NULL THEN RETURN false; END IF;
  IF NOT p_write AND sec.is_verifier(principal) THEN RETURN true; END IF;
  role:=sec.role_of(sec.viewer());
  RETURN coalesce(role IN('owner','admin','member') OR (NOT p_write AND role='guest'),false);
END
$$;
REVOKE ALL ON FUNCTION gov.identity_material_scope(uuid,boolean) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_material_scope(uuid,boolean) TO backbone_app,backbone_owner;
