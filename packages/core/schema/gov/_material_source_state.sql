-- Core journal state only; no current Host access or delivery authority.
-- live means a consistent Core journal observation, never current Host access or delivery.
CREATE FUNCTION gov._material_source_state(p_episode uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  system_id uuid := sec.system_principal();
  e app.episodes%ROWTYPE;
  b app.material_source_reads%ROWTYPE;
  observed_by uuid;
  run_task uuid;
  current_sensitive boolean;
  retired bigint;
BEGIN
  IF ws IS NULL OR system_id IS NULL OR p_episode IS NULL THEN RETURN 'unknown'; END IF;
  -- Both journal crossings use this same transaction-held lock. Read bindings are immutable;
  -- no binding FOR SHARE/UPDATE or extra UPDATE grant on the closed stores is needed.
  PERFORM gov._lock_workspace();
  SELECT source.* INTO e FROM app.episodes source WHERE source.workspace_id = ws AND source.id = p_episode;
  IF NOT FOUND THEN RETURN 'unknown'; END IF;
  SELECT reading.* INTO b FROM app.material_source_reads reading
  WHERE reading.workspace_id = ws AND reading.episode_id = p_episode;
  IF NOT FOUND THEN RETURN 'unknown'; END IF;
  SELECT identity.observed_by INTO observed_by FROM app.material_source_identities identity
  WHERE identity.workspace_id = ws AND identity.material_id = b.material_id AND identity.project_id = b.project_id;
  IF NOT FOUND OR observed_by IS DISTINCT FROM system_id
     OR b.recorded_by IS DISTINCT FROM system_id OR e.recorded_by IS DISTINCT FROM system_id
     OR e.source_kind IS DISTINCT FROM b.source_kind OR e.run_id IS DISTINCT FROM b.run_id
     OR e.authored_by IS DISTINCT FROM b.authored_by OR e.connection_id IS DISTINCT FROM b.connection_id
     OR e.content_hash IS DISTINCT FROM b.episode_sha256
     OR b.episode_sha256 IS DISTINCT FROM encode(sha256(convert_to(e.content, 'UTF8')), 'hex')
     OR e.document_id IS NOT NULL OR e.document_version IS NOT NULL THEN
    RETURN 'unknown';
  END IF;
  IF b.run_id IS NOT NULL THEN
    SELECT run.task_id INTO run_task FROM app.runs run WHERE run.workspace_id = ws AND run.id = b.run_id;
    IF NOT FOUND THEN RETURN 'unknown'; END IF;
  END IF;
  IF b.source_kind = 'file' THEN
    IF e.source_ref IS DISTINCT FROM 'material:' || b.material_id || '@v' || b.material_version::text
       OR e.task_id IS DISTINCT FROM coalesce(b.requested_task_id, run_task)
       OR e.trust IS DISTINCT FROM (CASE WHEN b.authored_by IS NULL THEN 'untrusted' ELSE 'trusted' END)
       OR b.connection_id IS NOT NULL OR b.tool IS NOT NULL THEN
      RETURN 'unknown';
    END IF;
  ELSIF b.source_kind = 'mcp' THEN
    IF b.run_id IS NULL OR b.connection_id IS NULL OR b.tool IS NULL OR b.requested_task_id IS NOT NULL
       OR b.authored_by IS NOT NULL OR e.task_id IS DISTINCT FROM run_task OR e.trust IS DISTINCT FROM 'untrusted'
       OR e.source_ref IS DISTINCT FROM 'mcp:' || b.connection_id::text || '/' || b.tool THEN
      RETURN 'unknown';
    END IF;
    SELECT connection.sensitive INTO current_sensitive FROM app.connections connection
    WHERE connection.workspace_id = ws AND connection.id = b.connection_id;
    IF NOT FOUND OR (current_sensitive AND NOT e.sensitive) THEN RETURN 'unknown'; END IF;
  ELSE
    RETURN 'unknown';
  END IF;
  -- This source version must have one consistent original-byte observation, not competing hashes.
  IF EXISTS (SELECT FROM app.material_source_reads other
             WHERE other.workspace_id = ws AND other.material_id = b.material_id
               AND other.material_version = b.material_version AND other.original_sha256 <> b.original_sha256) THEN
    RETURN 'unknown';
  END IF;
  IF EXISTS (SELECT FROM app.material_source_withdrawals withdrawal
             WHERE withdrawal.workspace_id = ws AND withdrawal.material_id = b.material_id
               AND withdrawal.generation >= b.generation) THEN
    RETURN 'withdrawn';
  END IF;
  SELECT count(*) INTO retired FROM app.material_source_withdrawals withdrawal
  WHERE withdrawal.workspace_id = ws AND withdrawal.material_id = b.material_id;
  IF retired <> b.generation THEN RETURN 'unknown'; END IF;
  -- The unique nonnegative tombstones below g, with exactly g rows, prove only Core's prefix.
  RETURN 'live';
END
$$;
REVOKE ALL ON FUNCTION gov._material_source_state(uuid) FROM PUBLIC, backbone_app, backbone_operator;
