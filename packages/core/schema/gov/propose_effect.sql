-- The one door (effect-gateway contract). A run, while it acts and at its current fence, proposes an
-- act outside Backbone's own state; the gateway decides its class, checks the mandate, refuses an
-- exact copy of a change whose earlier attempt is unresolved, routes it, and records the proposal.
-- A run bound to a piece acts within the mandate and that piece's declaration both (gov._piece_standing).
--
-- Exact copies (I-6; effect-gateway contract, L7b): the same change (task, beneficiary, operation, connection,
-- arguments and expected version) under any new key is a denied receipt linked to its original
-- while that original's outcome is UNKNOWN, for every change above class 1 (an interrupted write
-- inside the workspace is not resent blindly either, I-6); for a
-- connector change (mcp.*) also while the original is still in custody (not yet settled).
CREATE FUNCTION gov.propose_effect(
  p_run uuid, p_fence bigint, p_step integer, p_tool text, p_operation text, p_connection text, p_project text,
  p_class_hint smallint, p_external_hint boolean, p_args jsonb, p_description text, p_expected_version text,
  p_idempotency_key text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  r record;
  m record;
  existing record;
  conn_id uuid;
  cls record;
  hash text;
  new_id uuid := gen_random_uuid();
  tool text := coalesce(p_tool, 'call');
  standing text;
  routed text;
  status text;
  route text;
  reason text;
  repeat_of uuid;
  root uuid;
  not_before timestamptz;
  decision uuid;
  connector boolean := p_operation LIKE 'mcp.%';
BEGIN
  IF sec.current_run() IS DISTINCT FROM p_run THEN
    RAISE EXCEPTION 'not_in_run: effects are proposed only by the run that acts';
  END IF;
  SELECT * INTO r FROM app.runs x WHERE x.workspace_id = ws AND x.id = p_run;
  IF p_fence IS DISTINCT FROM r.fence THEN
    RAISE EXCEPTION 'stale: the run is held at another fence';
  END IF;
  IF p_args IS NULL OR p_operation IS NULL OR length(p_operation) = 0
     OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid: an effect states its operation, its arguments and an idempotency key';
  END IF;
  PERFORM gov._lock_workspace();
  hash := sec.args_hash(p_args);
  SELECT * INTO existing FROM app.effects x WHERE x.workspace_id = ws AND x.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing.operation = p_operation AND existing.args_hash = hash AND existing.connection IS NOT DISTINCT FROM p_connection
       AND existing.expected_version IS NOT DISTINCT FROM p_expected_version AND existing.run_id IS NOT DISTINCT FROM p_run THEN
      RETURN existing.id;
    END IF;
    RAISE EXCEPTION 'reused_key: the idempotency key names another change';
  END IF;
  -- The fence above was read before the lock. Closing a run takes the same lock, so a proposal that
  -- lost that race stops here: an open run is what lets recovery trust an empty receipt list.
  SELECT * INTO r FROM app.runs x WHERE x.workspace_id = ws AND x.id = p_run;
  IF p_fence IS DISTINCT FROM r.fence OR r.status <> 'running' THEN
    RAISE EXCEPTION 'stale: the run was closed or reclaimed while this was proposed';
  END IF;
  IF connector THEN
    IF p_connection IS NOT NULL AND p_connection <> split_part(p_operation, '.', 2) THEN
      RAISE EXCEPTION 'invalid: the change names another connector than its operation';
    END IF;
    SELECT c.id INTO conn_id FROM app.connections c WHERE c.workspace_id = ws AND c.slug = split_part(p_operation, '.', 2);
    IF EXISTS (SELECT FROM app.connections c WHERE c.workspace_id = ws AND c.id = conn_id AND c.scope = 'person'
               AND c.owner_id IS DISTINCT FROM gov._run_person(p_run)) THEN
      RAISE EXCEPTION 'denied: another person''s own connection is not this work''s to use';
    END IF;
  END IF;
  SELECT * INTO cls FROM gov._operation_class(p_operation, p_class_hint, p_external_hint, conn_id);
  SELECT * INTO m FROM app.mandates x WHERE x.workspace_id = ws AND x.id = r.mandate_id;

  standing := gov._mandate_standing(m.id);
  IF standing = 'ok' AND NOT (sec.set_covers(m.tools, tool) AND sec.set_covers(m.operations, p_operation)
       AND (p_connection IS NULL OR sec.set_covers(m.connections, p_connection))
       AND (p_project IS NULL OR sec.set_covers(m.projects, p_project))) THEN
    standing := 'outside_mandate';
  END IF;
  IF standing = 'ok' THEN
    standing := gov._piece_standing(r.carrier, r.piece_id, p_operation, cls.effect_class);
  END IF;
  IF standing = 'ok' THEN
    SELECT a INTO root FROM gov._ancestors(m.id) a
    JOIN app.mandates x ON x.workspace_id = ws AND x.id = a WHERE x.parent_id IS NULL;
    IF EXISTS (SELECT FROM app.effects e JOIN app.decisions d ON d.workspace_id = e.workspace_id AND d.id = e.decision_id
               WHERE e.workspace_id = ws AND e.operation = p_operation AND e.args_hash = hash
                 AND e.connection IS NOT DISTINCT FROM p_connection AND d.status = 'rejected'
                 AND e.mandate_id IN (SELECT gov._subtree(root))) THEN
      standing := 'already_rejected';
    END IF;
  END IF;

  IF standing = 'ok' AND cls.effect_class >= 2 THEN
    SELECT e.id INTO repeat_of FROM app.effects e
    WHERE e.workspace_id = ws AND e.repeat_of IS NULL AND e.task_id = r.task_id AND e.on_behalf_of_id = m.on_behalf_of_id
      AND e.operation = p_operation AND e.connection IS NOT DISTINCT FROM p_connection
      -- A document write names its new document's task or not; either form repeats the same write.
      AND (e.args_hash = hash OR (p_operation = 'workspace.write_document'
           AND sec.args_hash(e.args - 'task_id') = sec.args_hash(p_args - 'task_id')))
      AND e.expected_version IS NOT DISTINCT FROM p_expected_version AND e.status = 'unknown'
    ORDER BY e.created_at, e.id LIMIT 1;
    IF repeat_of IS NOT NULL THEN
      reason := 'repeat_unknown_blocked';
    ELSIF connector THEN
      SELECT e.id INTO repeat_of FROM app.effects e
      WHERE e.workspace_id = ws AND e.repeat_of IS NULL AND e.task_id = r.task_id AND e.on_behalf_of_id = m.on_behalf_of_id
        AND e.operation = p_operation AND e.connection IS NOT DISTINCT FROM p_connection AND e.args_hash = hash
        AND e.expected_version IS NOT DISTINCT FROM p_expected_version
        AND e.status IN ('proposed', 'awaiting_checker', 'allowed', 'claimed', 'dispatching')
      ORDER BY e.created_at, e.id LIMIT 1;
      IF repeat_of IS NOT NULL THEN
        reason := 'repeat_pending';
      END IF;
    END IF;
  END IF;

  IF repeat_of IS NOT NULL THEN
    status := 'denied';
    route := 'denied';
  ELSE
    routed := gov._route_for_run(r.id, cls.effect_class, standing, m.ceiling, cls.external, p_operation, p_args, conn_id);
    route := split_part(routed, ':', 1);
    reason := nullif(split_part(routed, ':', 2), '');
    status := CASE route WHEN 'needs_checker' THEN 'awaiting_checker' WHEN 'denied' THEN 'denied' ELSE 'allowed' END;
    IF route = 'allowed_after_window' THEN
      not_before := clock_timestamp() + make_interval(secs => (SELECT w.delay_window_ms FROM app.workspaces w WHERE w.id = ws) / 1000.0);
    END IF;
  END IF;

  INSERT INTO app.effects (workspace_id, id, run_id, task_id, step_seq, proposer_id, on_behalf_of_id, mandate_id, tool, operation,
                           connection, connection_id, project, effect_class, external_party, args, args_hash, description,
                           expected_version, idempotency_key, status, route, route_reason, repeat_of, not_before, kept)
  VALUES (ws, new_id, p_run, r.task_id, p_step, r.agent_id, m.on_behalf_of_id, m.id, tool, p_operation, p_connection, conn_id,
          p_project, cls.effect_class, cls.external, p_args, hash, coalesce(p_description, ''), p_expected_version,
          p_idempotency_key, status, route, reason, repeat_of, not_before, gov._run_kept(p_run));
  PERFORM gov._append('effect.proposed', new_id::text, gov._effect_payload(new_id) || jsonb_build_object(
    'run', p_run, 'route', route, 'reason', reason, 'repeat_of', repeat_of, 'description', sec.digest(p_description)));
  IF status = 'awaiting_checker' THEN
    decision := gov._ask_about_effect(new_id);
    UPDATE app.effects SET decision_id = decision WHERE workspace_id = ws AND id = new_id;
  ELSIF status = 'allowed' THEN
    PERFORM gov._enqueue_effect(new_id);
  END IF;
  RETURN new_id;
END
$$;
