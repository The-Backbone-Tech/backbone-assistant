-- An owner or an admin of the session's workspace.
CREATE FUNCTION sec.is_admin(p_principal uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$ SELECT coalesce(sec.role_of(p_principal) IN ('owner', 'admin'), false) $$;
