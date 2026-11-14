-- Queue a run of an agent on a task under a mandate it holds. The person the mandate serves queues
-- it, and must be able to see the task. A run starts with what its task's conversation carries.
-- It takes its mandate's carrier here, for good (sec.t_run_piece); p_piece, when given, must be the
-- mandate's piece.
CREATE FUNCTION gov.queue_run(p_task uuid, p_agent uuid, p_mandate uuid, p_routine uuid DEFAULT NULL, p_piece uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := sec.current_principal();
  m record;
  new_id uuid := gen_random_uuid();
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no_identity: the session acts as nobody';
  END IF;
  IF sec.names_run() THEN
    RAISE EXCEPTION 'not_by_runs: a run does not queue runs';
  END IF;
  IF NOT EXISTS (SELECT FROM app.tasks WHERE workspace_id = ws AND id = p_task) THEN
    RAISE EXCEPTION 'not_found: no such task in this workspace';
  END IF;
  IF NOT sec.task_visible(p_task) THEN
    RAISE EXCEPTION 'denied: the task is not shared with this person';
  END IF;
  SELECT * INTO m FROM app.mandates WHERE workspace_id = ws AND id = p_mandate;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such mandate in this workspace';
  END IF;
  IF m.subject_id <> p_agent THEN
    RAISE EXCEPTION 'mandate_holder: the run''s agent does not hold the mandate';
  END IF;
  IF me <> m.on_behalf_of_id AND me <> sec.system_principal() THEN
    RAISE EXCEPTION 'role: a run is queued by the person its mandate serves';
  END IF;
  IF m.revoked_at IS NOT NULL OR m.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'revoked: the mandate no longer stands';
  END IF;
  INSERT INTO app.runs (workspace_id, id, task_id, agent_id, mandate_id, routine_id, piece_id) VALUES (ws, new_id, p_task, p_agent, p_mandate, p_routine, p_piece);
  INSERT INTO ops.run_queue (run_id, workspace_id, carrier_key, claimable_after)
  SELECT new_id, ws, x.carrier_key, clock_timestamp() FROM app.runs x WHERE x.workspace_id = ws AND x.id = new_id;
  PERFORM gov._initial_marks(new_id);
  PERFORM gov._append('run.queued', new_id::text, jsonb_build_object('task', p_task, 'agent', p_agent, 'mandate', p_mandate,
    'carrier', (SELECT carrier_key FROM app.runs WHERE workspace_id = ws AND runs.id = new_id)));
  RETURN new_id;
END
$$;
