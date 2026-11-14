-- The system principal, outside any run, records exactly what was read. The database decides its
-- trust: words with no author in the workspace came from outside it and are untrusted, whatever the
-- recorder states. A person's words in a private task are private material. A run is given only a
-- source its person may see, and a person is claimed as author only where they could have written.
-- Recording for a run marks it, and marks only rise.
CREATE FUNCTION gov.record_source(
  p_kind text, p_ref text, p_content text, p_authored_by uuid, p_run uuid, p_task uuid,
  p_stated_trust text DEFAULT NULL, p_as uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := gov._system('system_records');
  new_id uuid := gen_random_uuid();
  kind text := coalesce(p_kind, 'file');
  ref text := coalesce(p_ref, 'source');
  task uuid := p_task;
  t_visibility text;
  t_person uuid;
  author_kind text;
  person uuid;
  trust text;
  private_to text;
  run_task uuid;
BEGIN
  -- Take the workspace before the source FK and taint update lock its run.
  PERFORM gov._lock_workspace();
  IF p_as IS NOT NULL AND p_as IS DISTINCT FROM me THEN
    RAISE EXCEPTION 'system_records: only the system principal records sources, as itself';
  END IF;
  IF p_content IS NULL THEN
    RAISE EXCEPTION 'invalid: a source has content';
  END IF;
  IF kind IN ('document', 'mcp') THEN
    RAISE EXCEPTION 'invalid: a document read names its document (read_document), a server''s answer its connection';
  END IF;
  IF kind NOT IN ('file', 'sandbox', 'message', 'web') THEN
    RAISE EXCEPTION 'invalid: no such kind of source';
  END IF;
  IF p_authored_by IS NOT NULL THEN
    SELECT p.kind INTO author_kind FROM app.principals p WHERE p.workspace_id = ws AND p.id = p_authored_by;
    IF author_kind IS NULL THEN
      RAISE EXCEPTION 'not_found: the author is not a principal of this workspace';
    END IF;
  END IF;
  IF p_run IS NOT NULL THEN
    SELECT r.task_id INTO run_task FROM app.runs r WHERE r.workspace_id = ws AND r.id = p_run;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found: no such run in this workspace';
    END IF;
    person := gov._run_person(p_run);
    IF task IS NOT NULL AND NOT sec.task_visible_to(task, person) THEN
      RAISE EXCEPTION 'denied: a run reads no source its person cannot see';
    END IF;
  END IF;
  IF task IS NOT NULL THEN
    SELECT x.visibility, x.on_behalf_of INTO t_visibility, t_person FROM app.tasks x WHERE x.workspace_id = ws AND x.id = task;
    IF t_visibility IS NULL THEN
      RAISE EXCEPTION 'not_found: no such task in this workspace';
    END IF;
    IF author_kind = 'person' AND NOT sec.task_visible_to(task, p_authored_by) THEN
      RAISE EXCEPTION 'invalid: a person is the author only of words they could have written';
    END IF;
  END IF;
  trust := CASE WHEN p_authored_by IS NULL THEN 'untrusted' ELSE 'trusted' END;
  IF author_kind = 'person' AND t_visibility = 'private' THEN
    SELECT p.name INTO private_to FROM app.principals p WHERE p.workspace_id = ws AND p.id = t_person;
  END IF;
  INSERT INTO app.episodes (workspace_id, id, source_kind, source_ref, trust, sensitive, content, content_hash, recorded_by,
                            authored_by, run_id, task_id)
  VALUES (ws, new_id, kind, ref, trust, private_to IS NOT NULL, p_content, encode(sha256(convert_to(p_content, 'UTF8')), 'hex'),
          me, p_authored_by, p_run, coalesce(task, run_task));
  IF p_run IS NOT NULL THEN
    PERFORM gov._mark(p_run,
      CASE WHEN trust = 'untrusted' THEN 'a source from outside the workspace (' || ref || ')' END,
      CASE WHEN private_to IS NOT NULL THEN ref || ', private to ' || private_to END,
      CASE WHEN private_to IS NOT NULL AND task IS DISTINCT FROM run_task THEN ref || ', private to ' || private_to END);
  END IF;
  PERFORM gov._append('source.recorded', new_id::text, jsonb_build_object(
    'kind', kind, 'trust', trust, 'run', p_run, 'task', coalesce(task, run_task), 'ref', sec.digest(ref),
    'content', sec.digest(p_content)));
  RETURN new_id;
END
$$;
