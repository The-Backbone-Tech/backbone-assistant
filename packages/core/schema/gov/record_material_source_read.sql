-- The system records a material read and its immutable link together. Identity and the original
-- byte digest come from the trusted Host under its home lock, never a harness label. Core proves
-- only its own writes; prepared text is not proof that an adapter or model received it.
CREATE FUNCTION gov.record_material_source_read(
  p_project text, p_material text, p_version integer, p_generation integer, p_read_key text,
  p_original_sha256 text, p_transformation jsonb, p_source_kind text,
  p_episode_content text, p_prepared_text text,
  p_authored_by uuid, p_run uuid, p_task uuid, p_connection uuid, p_tool text
) RETURNS TABLE (episode_id uuid, receipt_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := gov._system('system_records');
  identity_project text;
  prior app.material_source_reads%ROWTYPE;
  retired bigint;
  episode_hash text;
  prepared_hash text;
  new_episode uuid;
  new_receipt uuid;
  recipient record;
  beneficiary uuid;
  author_kind text;
  connection record;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'paused: material journaling requires READ COMMITTED isolation';
  END IF;
  IF p_project IS NULL OR octet_length(p_project) NOT BETWEEN 1 AND 512
     OR p_material IS NULL OR octet_length(p_material) NOT BETWEEN 1 AND 512
     OR p_version IS NULL OR p_version < 1 OR p_generation IS NULL OR p_generation < 0
     OR p_read_key IS NULL OR p_read_key !~ '^[a-f0-9]{64}$'
     OR p_original_sha256 IS NULL OR p_original_sha256 !~ '^[a-f0-9]{64}$'
     OR p_transformation IS NULL OR jsonb_typeof(p_transformation) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_transformation -> 'kind') IS DISTINCT FROM 'string'
     OR coalesce(length(p_transformation ->> 'kind'), 0) = 0
     OR jsonb_typeof(p_transformation -> 'version') IS DISTINCT FROM 'string'
     OR coalesce(length(p_transformation ->> 'version'), 0) = 0
     OR p_source_kind IS NULL OR p_source_kind NOT IN ('file', 'mcp')
     OR p_episode_content IS NULL OR p_prepared_text IS NULL THEN
    RAISE EXCEPTION 'invalid: a typed material read has exact identity, hashes, transformation and text';
  END IF;
  IF (p_source_kind = 'file' AND (p_connection IS NOT NULL OR p_tool IS NOT NULL))
     OR (p_source_kind = 'mcp' AND (p_connection IS NULL OR p_run IS NULL OR p_authored_by IS NOT NULL
       OR p_task IS NOT NULL OR p_tool IS NULL OR length(p_tool) = 0)) THEN
    RAISE EXCEPTION 'invalid: a typed file or connected answer preserves its native source rules';
  END IF;
  PERFORM gov._lock_workspace();
  INSERT INTO app.material_source_identities (workspace_id, material_id, project_id, observed_by)
  VALUES (ws, p_material, p_project, me)
  ON CONFLICT (workspace_id, material_id) DO NOTHING;
  SELECT i.project_id INTO identity_project FROM app.material_source_identities i
  WHERE i.workspace_id = ws AND i.material_id = p_material;
  IF identity_project IS DISTINCT FROM p_project THEN
    RAISE EXCEPTION 'conflict: a material identity already belongs to another project';
  END IF;
  -- These checks intentionally precede idempotent replay: an old receipt grants no fresh read
  -- after withdrawal, and an invented later generation cannot omit any prior withdrawal event.
  IF EXISTS (SELECT FROM app.material_source_withdrawals w
             WHERE w.workspace_id = ws AND w.material_id = p_material AND w.generation >= p_generation) THEN
    RAISE EXCEPTION 'denied: this material generation was withdrawn or is stale';
  END IF;
  SELECT count(*) INTO retired FROM app.material_source_withdrawals w
  WHERE w.workspace_id = ws AND w.material_id = p_material;
  -- Nonnegative, unique generations all below g, with exactly g rows, prove the prefix 0..g-1.
  IF retired <> p_generation THEN
    RAISE EXCEPTION 'paused: prior material withdrawals are not all confirmed by Core';
  END IF;
  -- Replay must not skip current Core access checks merely because its payload once committed.
  -- The system is the trusted recorder, not a holder claiming the run's secret or its fence.
  IF p_run IS NOT NULL THEN
    BEGIN
      -- Legacy server recording can lock a run before its ledger head; do not wait in reverse.
      SELECT r.task_id, r.status, m.revoked_at, m.expires_at INTO recipient
      FROM app.runs r JOIN app.mandates m ON m.workspace_id = r.workspace_id AND m.id = r.mandate_id
      WHERE r.workspace_id = ws AND r.id = p_run FOR UPDATE OF r NOWAIT FOR SHARE OF m NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'paused: the receiving run or mandate is changing; retry after it settles';
    END;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found: no such run in this workspace';
    END IF;
    IF recipient.status <> 'running' OR recipient.revoked_at IS NOT NULL OR recipient.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'stale: this material read no longer belongs to active work';
    END IF;
    beneficiary := gov._run_person(p_run);
    IF NOT sec.task_visible_to(recipient.task_id, beneficiary)
       OR (p_task IS NOT NULL AND NOT sec.task_visible_to(p_task, beneficiary)) THEN
      RAISE EXCEPTION 'denied: a run reads no source its person cannot see';
    END IF;
  END IF;
  IF p_source_kind = 'file' AND p_authored_by IS NOT NULL THEN
    SELECT p.kind INTO author_kind FROM app.principals p WHERE p.workspace_id = ws AND p.id = p_authored_by;
    IF author_kind IS NULL THEN
      RAISE EXCEPTION 'not_found: the author is not a principal of this workspace';
    END IF;
    IF p_task IS NOT NULL AND author_kind = 'person' AND NOT sec.task_visible_to(p_task, p_authored_by) THEN
      RAISE EXCEPTION 'invalid: a person is the author only of words they could have written';
    END IF;
  END IF;
  IF p_source_kind = 'file' AND p_task IS NOT NULL AND NOT EXISTS (
      SELECT FROM app.tasks t WHERE t.workspace_id = ws AND t.id = p_task) THEN
    RAISE EXCEPTION 'not_found: no such task in this workspace';
  END IF;
  IF p_source_kind = 'mcp' THEN
    BEGIN
      -- Connection marking can similarly hold its row before appending to the workspace ledger.
      SELECT c.* INTO connection FROM app.connections c
      WHERE c.workspace_id = ws AND c.id = p_connection FOR SHARE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'paused: connected source privacy is changing; retry after it settles';
    END;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid: a server''s answer names its connection';
    END IF;
  END IF;
  IF EXISTS (SELECT FROM app.material_source_reads r
             WHERE r.workspace_id = ws AND r.material_id = p_material AND r.material_version = p_version
               AND r.original_sha256 IS DISTINCT FROM p_original_sha256) THEN
    RAISE EXCEPTION 'conflict: this immutable material version was observed with different original bytes';
  END IF;
  episode_hash := encode(sha256(convert_to(p_episode_content, 'UTF8')), 'hex');
  prepared_hash := encode(sha256(convert_to(p_prepared_text, 'UTF8')), 'hex');
  SELECT r.* INTO prior FROM app.material_source_reads r
  WHERE r.workspace_id = ws AND r.read_key = p_read_key;
  IF FOUND THEN
    IF prior.material_id IS DISTINCT FROM p_material OR prior.project_id IS DISTINCT FROM p_project
       OR prior.material_version IS DISTINCT FROM p_version OR prior.generation IS DISTINCT FROM p_generation
       OR prior.original_sha256 IS DISTINCT FROM p_original_sha256
       OR prior.transformation IS DISTINCT FROM p_transformation
       OR prior.episode_sha256 IS DISTINCT FROM episode_hash OR prior.prepared_sha256 IS DISTINCT FROM prepared_hash
       OR prior.source_kind IS DISTINCT FROM p_source_kind OR prior.authored_by IS DISTINCT FROM p_authored_by
       OR prior.run_id IS DISTINCT FROM p_run OR prior.requested_task_id IS DISTINCT FROM p_task
       OR prior.connection_id IS DISTINCT FROM p_connection OR prior.tool IS DISTINCT FROM p_tool
       OR NOT EXISTS (SELECT FROM app.episodes e WHERE e.workspace_id = ws AND e.id = prior.episode_id
                      AND e.content IS NOT DISTINCT FROM p_episode_content AND e.content_hash = episode_hash) THEN
      RAISE EXCEPTION 'conflict: this material read key already records another payload';
    END IF;
    IF p_source_kind = 'mcp' THEN
      IF connection.sensitive AND NOT EXISTS (
          SELECT FROM app.episodes e WHERE e.workspace_id = ws AND e.id = prior.episode_id AND e.sensitive) THEN
        RAISE EXCEPTION 'paused: connected source privacy changed; the original preparation receipt is kept';
      END IF;
    END IF;
    RETURN QUERY SELECT prior.episode_id, prior.receipt_id;
    RETURN;
  END IF;
  IF p_source_kind = 'mcp' THEN
    new_episode := gov.record_server_answer(p_run, p_connection, p_tool, p_episode_content);
  ELSE
    new_episode := gov.record_source('file', 'material:' || p_material || '@v' || p_version::text,
                                    p_episode_content, p_authored_by, p_run, p_task);
  END IF;
  INSERT INTO app.material_source_reads AS inserted
    (workspace_id, read_key, episode_id, material_id, project_id, material_version, generation,
     original_sha256, transformation, episode_sha256, prepared_sha256, source_kind,
     authored_by, run_id, requested_task_id, connection_id, tool, recorded_by)
  VALUES (ws, p_read_key, new_episode, p_material, p_project, p_version, p_generation,
          p_original_sha256, p_transformation, episode_hash, prepared_hash, p_source_kind,
          p_authored_by, p_run, p_task, p_connection, p_tool, me)
  RETURNING inserted.receipt_id INTO new_receipt;
  PERFORM gov._append('material.read_registered', new_receipt::text, jsonb_build_object(
    'episode', new_episode, 'read_key', sec.digest(p_read_key),
    'project', sec.digest(p_project), 'material', sec.digest(p_material),
    'version', p_version, 'generation', p_generation, 'kind', p_source_kind,
    'original_sha256', sec.digest(p_original_sha256), 'transformation', sec.digest(p_transformation::text),
    'episode_sha256', sec.digest(episode_hash), 'prepared_sha256', sec.digest(prepared_hash)));
  RETURN QUERY SELECT new_episode, new_receipt;
END
$$;
REVOKE ALL ON FUNCTION gov.record_material_source_read(text,text,integer,integer,text,text,jsonb,text,text,text,uuid,uuid,uuid,uuid,text)
  FROM PUBLIC, backbone_app;
GRANT EXECUTE ON FUNCTION gov.record_material_source_read(text,text,integer,integer,text,text,jsonb,text,text,text,uuid,uuid,uuid,uuid,text)
  TO backbone_app;
