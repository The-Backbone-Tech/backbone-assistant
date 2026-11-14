-- A person sets a routine for one of their own workers: its own private task, and a root mandate for
-- its firings. An instruction routine holds the person's instruction in its task. Its firings are
-- direct work, carried by the installation's own scheduler and worker, never by a piece.
CREATE FUNCTION gov.create_routine(p_agent uuid, p_kind text, p_title text, p_instruction text, p_schedule text, p_timezone text,
                                   p_ceiling smallint, p_expires_at timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := gov._person('not_by_runs');
  task uuid := gen_random_uuid();
  mandate uuid;
  new_id uuid := gen_random_uuid();
  kind text := coalesce(p_kind, 'instruction');
BEGIN
  IF kind NOT IN ('instruction', 'morning_brief', 'nightly_tidy') THEN
    RAISE EXCEPTION 'invalid: no such kind of routine';
  END IF;
  IF NOT EXISTS (SELECT FROM app.principals p WHERE p.workspace_id = ws AND p.id = p_agent AND p.kind = 'agent'
                 AND p.agent_role = 'worker' AND p.owner_id = me) THEN
    RAISE EXCEPTION 'role: a routine is set for one of its person''s own workers';
  END IF;
  INSERT INTO app.tasks (workspace_id, id, title, visibility, kind, requested_by, on_behalf_of)
  VALUES (ws, task, coalesce(p_title, 'Routine'), 'private', 'routine', me, me);
  mandate := gov.issue_mandate(p_agent, NULL, '"*"', '"*"', '"*"', '"*"', coalesce(p_ceiling, 4::smallint), NULL, NULL, NULL, NULL,
                               coalesce(p_expires_at, clock_timestamp() + interval '30 days'), 'direct');
  INSERT INTO app.routines (workspace_id, id, person_id, agent_id, task_id, mandate_id, kind, title, instruction, schedule, timezone)
  VALUES (ws, new_id, me, p_agent, task, mandate, kind, coalesce(p_title, 'Routine'),
          CASE WHEN kind = 'instruction' THEN p_instruction END, p_schedule, p_timezone);
  PERFORM gov._append('routine.created', new_id::text, jsonb_build_object('kind', kind, 'task', task, 'mandate', mandate,
                                                                          'instruction', sec.digest(p_instruction)));
  RETURN new_id;
END
$$;
