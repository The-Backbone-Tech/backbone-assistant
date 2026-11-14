-- Add a person to the workspace, as an owner or admin. Only an owner adds an owner.
CREATE OR REPLACE FUNCTION gov.add_person(p_name text, p_email text, p_role text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := gov._admin();
  new_id uuid := gen_random_uuid();
BEGIN
  IF p_role IS NULL OR p_role NOT IN ('owner', 'admin', 'member', 'guest') THEN
    RAISE EXCEPTION 'invalid: a role is owner, admin, member or guest';
  END IF;
  IF p_role = 'owner' AND sec.role_of(me) <> 'owner' THEN
    RAISE EXCEPTION 'role: only an owner adds an owner';
  END IF;
  INSERT INTO app.principals (workspace_id, id, kind, role, name, email)
  VALUES (sec.current_workspace(), new_id, 'person', p_role, p_name, p_email);
  PERFORM gov._append('person.added', new_id::text, jsonb_build_object('role', p_role));
  RETURN new_id;
END
$$;
REVOKE EXECUTE ON FUNCTION gov.add_person(text,text,text) FROM backbone_app;
