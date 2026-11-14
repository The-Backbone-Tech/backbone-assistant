-- What the dispatcher writes while it dispatches a document effect: the document the effect's
-- arguments name, created in the task they name and nowhere else, or a new version of it. The
-- words carry what the proposing run had read; a person's later edit never lowers that. A write by a
-- run marked both ways that was allowed without a checker, because its task was private to the run's
-- person, is refused if that task has since been shared: the task row is locked, so sharing or joining
-- waits for the write or the write sees it.
CREATE FUNCTION gov.write_document_by_effect(
  p_effect uuid, p_document uuid, p_title text, p_content text, p_create boolean, p_task uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := gov._system();
  e record;
  run_untrusted boolean := false;
  run_sensitive boolean := false;
  d record;
  author uuid;
  named_task uuid;
  doc uuid;
  target_task uuid;
  person uuid;
BEGIN
  SELECT * INTO e FROM app.effects x WHERE x.workspace_id = ws AND x.id = p_effect;
  IF NOT FOUND OR e.status <> 'dispatching' OR e.operation NOT IN ('workspace.write_document', 'workspace.restore_document') THEN
    RAISE EXCEPTION 'stale: no document effect of this id is being dispatched';
  END IF;
  -- The dispatcher writes the document the receipt names, never another one under its approval.
  IF (e.operation = 'workspace.write_document' AND nullif(e.args ->> 'document_id', '') IS NULL)
     OR (p_document IS NOT NULL AND e.args ? 'document_id' AND p_document::text IS DISTINCT FROM e.args ->> 'document_id') THEN
    RAISE EXCEPTION 'invalid: a document effect writes the document its arguments name';
  END IF;
  doc := coalesce(p_document, nullif(e.args ->> 'document_id', '')::uuid);
  author := e.proposer_id;
  IF e.run_id IS NOT NULL THEN
    SELECT x.tainted_untrusted, x.tainted_sensitive INTO run_untrusted, run_sensitive FROM app.runs x WHERE x.workspace_id = ws AND x.id = e.run_id;
  END IF;
  SELECT * INTO d FROM app.documents x WHERE x.workspace_id = ws AND x.id = doc FOR UPDATE;
  IF e.operation = 'workspace.write_document' AND run_untrusted AND run_sensitive AND e.route IS DISTINCT FROM 'needs_checker' THEN
    target_task := CASE WHEN FOUND THEN d.task_id ELSE nullif(e.args ->> 'task_id', '')::uuid END;
    person := gov._run_person(e.run_id);
    PERFORM FROM app.tasks t WHERE t.workspace_id = ws AND t.id = target_task FOR UPDATE;
    IF target_task IS NULL OR gov._task_read_beyond(target_task, person) OR NOT EXISTS (
         SELECT FROM app.tasks t WHERE t.workspace_id = ws AND t.id = target_task AND t.requested_by = person AND t.on_behalf_of = person) THEN
      RAISE EXCEPTION 'audience_changed: the task was shared after this write was routed; it needs a checker now';
    END IF;
    SELECT * INTO d FROM app.documents x WHERE x.workspace_id = ws AND x.id = doc;
  END IF;
  IF NOT FOUND THEN
    IF NOT coalesce(p_create, true) THEN
      RAISE EXCEPTION 'not_found: no such document';
    END IF;
    named_task := nullif(e.args ->> 'task_id', '')::uuid;
    IF p_task IS DISTINCT FROM named_task THEN
      RAISE EXCEPTION 'invalid: a new document goes into the task its effect''s arguments name';
    END IF;
    INSERT INTO app.documents (workspace_id, id, task_id, title, content, updated_by, content_author, via_effect,
                               words_untrusted, words_sensitive)
    VALUES (ws, doc, named_task, coalesce(p_title, e.args ->> 'title', 'Untitled'), coalesce(p_content, e.args ->> 'content', ''), me,
            author, p_effect, run_untrusted, run_sensitive);
  ELSE
    UPDATE app.documents SET
      title = coalesce(p_title, title), content = coalesce(p_content, content), updated_by = me, via_effect = p_effect,
      content_author = CASE WHEN coalesce(p_content, content) IS DISTINCT FROM content THEN author ELSE content_author END,
      words_untrusted = words_untrusted OR run_untrusted,
      words_sensitive = words_sensitive OR run_sensitive
    WHERE workspace_id = ws AND id = doc;
  END IF;
  PERFORM gov._append('document.written', doc::text, jsonb_build_object(
    'effect', p_effect, 'version', (SELECT x.version FROM app.documents x WHERE x.workspace_id = ws AND x.id = doc)));
  RETURN doc;
END
$$;
