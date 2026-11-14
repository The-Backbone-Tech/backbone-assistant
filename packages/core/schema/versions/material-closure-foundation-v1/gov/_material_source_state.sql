-- Material closure foundation v1. Canonical versioned source; see its closed manifest.
CREATE OR REPLACE FUNCTION gov._material_source_state(p_episode uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  observed text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'paused: material validation requires READ COMMITTED isolation';
  END IF;
  -- Preserve the old unknown result for an absent workspace/system/episode identity.
  -- The projection repeats these identity checks in the later authoritative statement.
  IF sec.current_workspace() IS NULL OR sec.system_principal() IS NULL OR p_episode IS NULL THEN
    RETURN 'unknown';
  END IF;
  PERFORM gov._lock_workspace();
  -- A separate SELECT after the lock: never a STABLE projection in the waiting statement.
  SELECT gov._material_source_projection(p_episode) INTO observed;
  RETURN observed;
END
$$;
REVOKE ALL ON FUNCTION gov._material_source_state(uuid) FROM PUBLIC, backbone_app, backbone_operator;
