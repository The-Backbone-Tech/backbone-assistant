-- An owner or admin changes a person's role. Only an owner makes or unmakes an owner.
CREATE FUNCTION gov.change_role(p_person uuid, p_role text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := gov._admin();
  was text := sec.role_of(p_person);
BEGIN
  IF was IS NULL THEN
    RAISE EXCEPTION 'not_found: no such person in this workspace';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('owner', 'admin', 'member', 'guest') THEN
    RAISE EXCEPTION 'invalid: a role is owner, admin, member or guest';
  END IF;
  IF (was = 'owner' OR p_role = 'owner') AND sec.role_of(me) <> 'owner' THEN
    RAISE EXCEPTION 'role: only an owner makes or unmakes an owner';
  END IF;
  UPDATE app.principals SET role = p_role WHERE workspace_id = sec.current_workspace() AND id = p_person;
  PERFORM gov._append('person.role_changed', p_person::text, jsonb_build_object('from', was, 'to', p_role));
  RETURN p_role;
END
$$;
