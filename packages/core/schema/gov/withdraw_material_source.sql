-- The system records an idempotent withdrawal of an entire generation without deleting evidence.
CREATE FUNCTION gov.withdraw_material_source(
  p_project text, p_material text, p_event text, p_sequence integer,
  p_observed_version integer, p_event_at text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := gov._system('system_records');
  identity_project text;
  prior app.material_source_withdrawals%ROWTYPE;
  new_receipt uuid;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'paused: material journaling requires READ COMMITTED isolation';
  END IF;
  IF p_project IS NULL OR octet_length(p_project) NOT BETWEEN 1 AND 512
     OR p_material IS NULL OR octet_length(p_material) NOT BETWEEN 1 AND 512
     OR p_event IS NULL OR p_event !~ '^[a-f0-9]{64}$'
     OR p_sequence IS NULL OR p_sequence < 1
     OR p_observed_version IS NULL OR p_observed_version < 1
     OR p_event_at IS NULL OR p_event_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
  THEN
    RAISE EXCEPTION 'invalid: an immutable material withdrawal has identity, sequence, version and an explicit timestamp';
  END IF;
  IF NOT isfinite(p_event_at::timestamptz) THEN
    RAISE EXCEPTION 'invalid: a material withdrawal timestamp is finite';
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
  SELECT w.* INTO prior FROM app.material_source_withdrawals w
  WHERE w.workspace_id = ws AND w.event_id = p_event;
  IF FOUND THEN
    IF prior.material_id IS DISTINCT FROM p_material OR prior.project_id IS DISTINCT FROM p_project
       OR prior.sequence IS DISTINCT FROM p_sequence OR prior.observed_version IS DISTINCT FROM p_observed_version
       OR prior.event_at IS DISTINCT FROM p_event_at THEN
      RAISE EXCEPTION 'conflict: this withdrawal event already records another payload';
    END IF;
    RETURN prior.receipt_id;
  END IF;
  IF EXISTS (SELECT FROM app.material_source_withdrawals w
             WHERE w.workspace_id = ws AND w.material_id = p_material AND w.generation = p_sequence - 1) THEN
    RAISE EXCEPTION 'conflict: this material generation already has another withdrawal event';
  END IF;
  INSERT INTO app.material_source_withdrawals
    (workspace_id, event_id, material_id, project_id, sequence, generation, observed_version, event_at, recorded_by)
  VALUES (ws, p_event, p_material, p_project, p_sequence, p_sequence - 1, p_observed_version, p_event_at, me)
  RETURNING receipt_id INTO new_receipt;
  PERFORM gov._append('material.source_withdrawn', new_receipt::text, jsonb_build_object(
    'event', sec.digest(p_event), 'project', sec.digest(p_project), 'material', sec.digest(p_material),
    'sequence', p_sequence, 'generation', p_sequence - 1, 'observed_version', p_observed_version,
    'event_at', sec.digest(p_event_at)));
  RETURN new_receipt;
END
$$;
REVOKE ALL ON FUNCTION gov.withdraw_material_source(text,text,text,integer,integer,text) FROM PUBLIC, backbone_app;
GRANT EXECUTE ON FUNCTION gov.withdraw_material_source(text,text,text,integer,integer,text) TO backbone_app;
