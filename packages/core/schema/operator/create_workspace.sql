-- The operator's crossing (SG-CORE-01): any workspace, by the installation's operator role alone.
-- The first workspace it creates counts as the installation's first.
CREATE FUNCTION operator.create_workspace(p_name text, p_kind text, p_owner_name text, p_owner_email text)
RETURNS TABLE (workspace_id uuid, owner_id uuid, system_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  PERFORM 1 FROM ops.installation FOR UPDATE;
  RETURN QUERY SELECT * FROM gov._create_workspace(p_name, p_kind, p_owner_name, p_owner_email);
  UPDATE ops.installation SET first_workspace = coalesce(first_workspace, sec.current_workspace());
END
$$;
