-- A person forgets one of their memories: the words are erased, for good.
CREATE FUNCTION gov.forget_memory(p_memory uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := sec.current_principal();
  m record;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no_identity: the session acts as nobody';
  END IF;
  SELECT * INTO m FROM app.memory WHERE workspace_id = sec.current_workspace() AND id = p_memory AND forgotten_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such memory to forget';
  END IF;
  IF sec.names_run() OR m.owner_id <> me THEN
    RAISE EXCEPTION 'someone_else: only its person forgets a memory';
  END IF;
  UPDATE app.memory SET content = '', forgotten_at = clock_timestamp() WHERE workspace_id = m.workspace_id AND id = p_memory;
  PERFORM gov._append('memory.forgotten', p_memory::text, '{}');
  RETURN p_memory;
END
$$;
