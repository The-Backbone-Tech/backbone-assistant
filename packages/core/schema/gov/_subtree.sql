-- A mandate and every mandate delegated from it, at any depth.
CREATE FUNCTION gov._subtree(p_mandate uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  WITH RECURSIVE t AS (
    SELECT id FROM app.mandates WHERE workspace_id = sec.current_workspace() AND id = p_mandate
    UNION
    SELECT m.id FROM app.mandates m JOIN t ON m.workspace_id = sec.current_workspace() AND m.parent_id = t.id
  ) SELECT id FROM t
$$;
