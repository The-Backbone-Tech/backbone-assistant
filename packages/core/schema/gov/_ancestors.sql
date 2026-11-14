-- A mandate and each mandate it was delegated from, up to its root.
CREATE FUNCTION gov._ancestors(p_mandate uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  WITH RECURSIVE t AS (
    SELECT id, parent_id FROM app.mandates WHERE workspace_id = sec.current_workspace() AND id = p_mandate
    UNION
    SELECT m.id, m.parent_id FROM app.mandates m JOIN t ON m.workspace_id = sec.current_workspace() AND m.id = t.parent_id
  ) SELECT id FROM t
$$;
