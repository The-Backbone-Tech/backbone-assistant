-- The system principal records that a run read a version of a document (the current one unless
-- stated): exactly what that version held, with the document's own author and task, whatever the
-- recorder claims. A run reads only what its person may see. Reading marks the run.
CREATE FUNCTION gov.read_document(p_run uuid, p_document uuid, p_version integer DEFAULT NULL, p_claimed_content text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := gov._system('system_records');
  d record;
  v record;
  reasons record;
  person uuid;
  new_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO d FROM app.documents x WHERE x.workspace_id = ws AND x.id = p_document;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such document';
  END IF;
  IF p_version IS NULL OR p_version = d.version THEN
    SELECT d.version, d.content, d.content_author INTO v;
  ELSE
    SELECT x.version, x.content, x.content_author INTO v FROM app.document_versions x
    WHERE x.workspace_id = ws AND x.document_id = p_document AND x.version = p_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found: no such version of the document';
    END IF;
  END IF;
  IF p_claimed_content IS NOT NULL AND p_claimed_content <> v.content THEN
    RAISE EXCEPTION 'invalid: a recorded document is exactly what that version held';
  END IF;
  person := gov._run_person(p_run);
  IF person IS NULL OR (d.task_id IS NOT NULL AND NOT sec.task_visible_to(d.task_id, person)) THEN
    RAISE EXCEPTION 'denied: a run reads no document its person cannot see';
  END IF;
  reasons := gov._document_reasons(p_document, p_run);
  INSERT INTO app.episodes (workspace_id, id, source_kind, source_ref, trust, sensitive, content, content_hash, recorded_by,
                            authored_by, run_id, task_id, document_id, document_version)
  VALUES (ws, new_id, 'document', 'document:' || p_document || '@' || v.version,
          CASE WHEN reasons.untrusted IS NULL THEN 'trusted' ELSE 'untrusted' END, reasons.sensitive IS NOT NULL,
          v.content, encode(sha256(convert_to(v.content, 'UTF8')), 'hex'), me, v.content_author, p_run, d.task_id, p_document, v.version);
  PERFORM gov._mark(p_run, reasons.untrusted, reasons.sensitive, reasons.elsewhere);
  PERFORM gov._append('source.recorded', new_id::text, jsonb_build_object('kind', 'document', 'run', p_run, 'document', p_document,
                                                                          'version', v.version));
  RETURN new_id;
END
$$;
