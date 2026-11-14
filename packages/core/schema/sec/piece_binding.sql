-- Whether work may be bound to a registered piece in the session's workspace: 'ok', 'not_registered'
-- (unknown here, or unregistered), or 'outside_plane' (it does not declare this workspace's plane).
CREATE FUNCTION sec.piece_binding(p_piece uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p.id IS NULL OR p.unregistered_at IS NOT NULL THEN 'not_registered'
    WHEN NOT p.planes ? w.kind THEN 'outside_plane'
    ELSE 'ok' END
  FROM app.workspaces w LEFT JOIN app.pieces p ON p.workspace_id = w.id AND p.id = p_piece
  WHERE w.id = sec.current_workspace()
$$;
