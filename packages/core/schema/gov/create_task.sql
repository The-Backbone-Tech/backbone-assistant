-- A person files a task of their own; the system principal files one for a person. Private unless
-- stated otherwise. A row may not name another workspace, nor point at another workspace's people.
CREATE FUNCTION gov.create_task(
  p_requested_by uuid, p_on_behalf_of uuid, p_title text, p_goal text, p_visibility text, p_kind text DEFAULT 'task',
  p_workspace uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := sec.current_principal();
  new_id uuid := gen_random_uuid();
  beneficiary uuid := coalesce(p_on_behalf_of, p_requested_by);
BEGIN
  IF p_workspace IS NOT NULL AND p_workspace IS DISTINCT FROM ws THEN
    RAISE EXCEPTION 'denied: the task names another workspace than the session''s';
  END IF;
  IF me IS NULL THEN
    RAISE EXCEPTION 'no_identity: the session acts as nobody';
  END IF;
  IF sec.principal_kind(p_requested_by) IS DISTINCT FROM 'person' OR sec.principal_kind(beneficiary) IS DISTINCT FROM 'person' THEN
    RAISE EXCEPTION 'not_found: a task is for a person of this workspace';
  END IF;
  IF sec.names_run() OR (me <> sec.system_principal() AND me <> p_requested_by) THEN
    RAISE EXCEPTION 'role: a person files their own tasks; the system files tasks for others';
  END IF;
  IF coalesce(p_visibility, 'private') NOT IN ('private', 'workspace') THEN
    RAISE EXCEPTION 'invalid: a task is private or shared with the workspace';
  END IF;
  INSERT INTO app.tasks (workspace_id, id, title, goal, visibility, kind, requested_by, on_behalf_of)
  VALUES (ws, new_id, coalesce(p_title, 'Untitled'), p_goal, coalesce(p_visibility, 'private'), coalesce(p_kind, 'task'), p_requested_by, beneficiary);
  PERFORM gov._append('task.created', new_id::text, jsonb_build_object('visibility', coalesce(p_visibility, 'private'), 'for', beneficiary));
  RETURN new_id;
END
$$;
