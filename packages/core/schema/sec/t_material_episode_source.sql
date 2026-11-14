-- Every reserved material episode requires its own typed live journal binding at validation.
CREATE FUNCTION sec.t_material_episode_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid;
  state text;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_TABLE_SCHEMA <> 'app' OR TG_TABLE_NAME <> 'episodes' THEN
    RAISE EXCEPTION 'invalid: material source enforcement belongs only to episode insertion';
  END IF;
  -- Exact, case-sensitive reserved file namespace; MCP never relies on source_ref uniqueness.
  IF NOT (NEW.source_kind = 'mcp'
      OR (NEW.source_kind = 'file' AND left(NEW.source_ref, 9) COLLATE "C" = 'material:')) THEN
    RETURN NEW;
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'paused: material journaling requires READ COMMITTED isolation';
  END IF;
  me := gov._system('system_records');
  IF NEW.workspace_id IS DISTINCT FROM sec.current_workspace() OR NEW.recorded_by IS DISTINCT FROM me THEN
    RAISE EXCEPTION 'paused: the material episode and current recorder do not share a verified workspace';
  END IF;
  PERFORM gov._lock_workspace();
  -- A validated immediate, nondeferrable binding FK plus the episode's unique workspace/id
  -- prevents a prior committed binding for this new row. Ordinary MVCC exposes no other
  -- transaction's uncommitted binding. A visible exact binding before this insert commits
  -- therefore belongs to this transaction, including legitimate released savepoints.
  state := gov._material_source_state(NEW.id);
  IF state IS DISTINCT FROM 'live' THEN
    RAISE EXCEPTION 'paused: the material episode is withdrawn or its Core journal state is unknown';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION sec.t_material_episode_source() FROM PUBLIC, backbone_app, backbone_operator;
-- The non-login store owner needs this only to create its trigger; execution uses the definer.
GRANT EXECUTE ON FUNCTION sec.t_material_episode_source() TO backbone_owner;
