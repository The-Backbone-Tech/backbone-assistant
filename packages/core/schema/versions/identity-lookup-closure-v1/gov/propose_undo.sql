-- A person reverses a completed effect through the gateway: the person it was for, or an owner or
-- admin who sees it; never a run or an agent. Only a succeeded effect whose operation has a way
-- back is undoable, and one undo stands at a time. The undo is the person's own act: within their
-- role it is allowed, above it it goes to another owner or admin (effect-gateway contract, undo).
CREATE OR REPLACE FUNCTION gov.propose_undo(p_effect uuid, p_args jsonb, p_description text, p_expected_version text, p_idempotency_key text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := sec.current_principal();
  e record;
  beneficiary jsonb;
  existing record;
  cls record;
  undo_op text;
  new_id uuid := gen_random_uuid();
  hash text;
  role_ceiling smallint;
  status text;
  route text;
  reason text;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no_identity: the session acts as nobody';
  END IF;
  PERFORM gov._lock_workspace();
  me:=sec.current_principal();
  IF me IS NULL THEN RAISE EXCEPTION 'no_identity: the session acts as nobody'; END IF;
  IF sec.names_run() OR sec.principal_kind(me) <> 'person' THEN
    RAISE EXCEPTION 'role: an undo is asked for by a person';
  END IF;
  beneficiary:=gov.identity_effect_owner(p_effect);
  IF beneficiary IS NULL THEN RAISE EXCEPTION 'not_found: no such effect in this workspace'; END IF;
  IF me IS DISTINCT FROM (beneficiary->>'person')::uuid AND NOT sec.is_admin(me) THEN
    RAISE EXCEPTION 'not_found: no such effect in this workspace';
  END IF;
  SELECT * INTO e FROM app.effects x WHERE x.workspace_id = ws AND x.id = p_effect;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found: no such effect in this workspace'; END IF;
  IF me <> e.on_behalf_of_id AND NOT (sec.is_admin(me) AND sec.effect_visible(p_effect)) THEN
    RAISE EXCEPTION 'not_found: no such effect in this workspace';
  END IF;
  hash := sec.args_hash(coalesce(p_args, '{}'));
  SELECT * INTO existing FROM app.effects x WHERE x.workspace_id = ws AND x.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing.undo_of IS NOT DISTINCT FROM p_effect AND existing.args_hash = hash THEN
      RETURN existing.id;
    END IF;
    RAISE EXCEPTION 'reused_key: the idempotency key names another change';
  END IF;
  SELECT x.undo INTO undo_op FROM gov._operation_class(e.operation, NULL, NULL, NULL) x;
  IF e.status <> 'succeeded' OR undo_op IS NULL OR e.undo_of IS NOT NULL THEN
    RAISE EXCEPTION 'not_undoable: only a completed effect with a way back is undone';
  END IF;
  IF EXISTS (SELECT FROM app.effects x WHERE x.workspace_id = ws AND x.undo_of = p_effect AND x.status NOT IN ('cancelled', 'denied', 'failed')) THEN
    RAISE EXCEPTION 'conflict: an undo of this effect already stands';
  END IF;
  SELECT * INTO cls FROM gov._operation_class(undo_op, NULL, NULL, NULL);
  role_ceiling := CASE WHEN sec.is_admin(me) THEN 4 ELSE 3 END;
  IF cls.effect_class > role_ceiling THEN
    status := 'awaiting_checker';
    route := 'needs_checker';
    reason := 'above_role';
  ELSE
    status := 'allowed';
    route := CASE WHEN cls.effect_class = 1 THEN 'free' ELSE 'allowed' END;
  END IF;
  INSERT INTO app.effects (workspace_id, id, run_id, task_id, proposer_id, on_behalf_of_id, mandate_id, tool, operation, connection,
                           effect_class, external_party, args, args_hash, description, expected_version, idempotency_key,
                           status, route, route_reason, undo_of)
  VALUES (ws, new_id, NULL, e.task_id, me, e.on_behalf_of_id, NULL, 'undo', undo_op, e.connection, cls.effect_class, cls.external,
          coalesce(p_args, '{}'), hash, coalesce(p_description, ''), p_expected_version, p_idempotency_key, status, route, reason, p_effect);
  PERFORM gov._append('effect.proposed', new_id::text, gov._effect_payload(new_id) || jsonb_build_object(
    'route', route, 'reason', reason, 'description', sec.digest(p_description)));
  IF status = 'awaiting_checker' THEN
    UPDATE app.effects SET decision_id = gov._open_decision('effect', new_id, me, e.on_behalf_of_id, reason, hash,
      gov._effect_question(new_id), false, 'person', NULL) WHERE workspace_id = ws AND id = new_id;
  ELSE
    PERFORM gov._enqueue_effect(new_id);
  END IF;
  RETURN new_id;
END
$$;
