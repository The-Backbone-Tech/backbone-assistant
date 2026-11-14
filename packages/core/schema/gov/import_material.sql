-- The system principal records what was imported from another agent's store for a person: a
-- private task holding its documents (imported, untrusted until the person reviews them) and its
-- memories as proposals the person may accept. Returns the task.
CREATE FUNCTION gov.import_material(p_person uuid, p_source text, p_material jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := gov._system('system_records');
  task uuid := gen_random_uuid();
  source text := coalesce(p_source, 'openclaw');
  x jsonb;
BEGIN
  IF sec.principal_kind(p_person) IS DISTINCT FROM 'person' THEN
    RAISE EXCEPTION 'not_found: material is imported for a person of this workspace';
  END IF;
  INSERT INTO app.tasks (workspace_id, id, title, visibility, kind, requested_by, on_behalf_of)
  VALUES (ws, task, 'Imported from ' || gov._source_name(source), 'private', 'import', p_person, p_person);
  FOR x IN SELECT * FROM jsonb_array_elements(coalesce(p_material -> 'documents', '[]')) LOOP
    INSERT INTO app.documents (workspace_id, task_id, title, content, updated_by, content_author, imported)
    VALUES (ws, task, coalesce(x ->> 'title', 'Imported'), coalesce(x ->> 'content', ''), me, me, true);
  END LOOP;
  FOR x IN SELECT * FROM jsonb_array_elements(coalesce(p_material -> 'memories', '[]')) LOOP
    INSERT INTO app.memory_proposals (workspace_id, person_id, source, content, path, line)
    VALUES (ws, p_person, source, coalesce(x ->> 'content', ''), x ->> 'path', (x ->> 'line')::integer);
  END LOOP;
  IF p_material ->> 'notice' IS NOT NULL THEN
    INSERT INTO app.messages (workspace_id, task_id, role, content) VALUES (ws, task, 'system', p_material ->> 'notice');
  END IF;
  PERFORM gov._append('material.imported', task::text, jsonb_build_object('person', p_person, 'source', source));
  RETURN task;
END
$$;
