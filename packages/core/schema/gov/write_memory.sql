-- Memory is written for one person: by that person, or by a run acting for them. A step replayed
-- after a crash remembers once. What the writing run had read untrusted stays on the words.
CREATE FUNCTION gov.write_memory(p_owner uuid, p_agent uuid, p_content text, p_step integer DEFAULT NULL, p_workspace uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := sec.current_principal();
  run uuid := sec.current_run();
  new_id uuid := gen_random_uuid();
  existing uuid;
  untrusted boolean := false;
BEGIN
  IF p_workspace IS NOT NULL AND p_workspace IS DISTINCT FROM ws THEN
    RAISE EXCEPTION 'denied: the memory names another workspace than the session''s';
  END IF;
  IF me IS NULL THEN
    RAISE EXCEPTION 'no_identity: the session acts as nobody';
  END IF;
  IF sec.acting_for() IS DISTINCT FROM p_owner OR (run IS NULL AND me <> p_owner) THEN
    RAISE EXCEPTION 'denied: memory is written only for the person the session acts for';
  END IF;
  IF p_content IS NULL OR length(p_content) = 0 THEN
    RAISE EXCEPTION 'invalid: a memory has words';
  END IF;
  IF run IS NOT NULL THEN
    SELECT tainted_untrusted INTO untrusted FROM app.runs WHERE workspace_id = ws AND id = run;
    IF p_step IS NOT NULL THEN
      SELECT id INTO existing FROM app.memory
      WHERE workspace_id = ws AND run_id = run AND step_seq = p_step AND content = p_content;
      IF existing IS NOT NULL THEN
        RETURN existing;
      END IF;
    END IF;
  END IF;
  INSERT INTO app.memory (workspace_id, id, owner_id, agent_id, content, words_untrusted, run_id, step_seq)
  VALUES (ws, new_id, p_owner, p_agent, p_content, coalesce(untrusted, false), run, p_step);
  PERFORM gov._append('memory.written', new_id::text, jsonb_build_object('owner', p_owner, 'run', run));
  RETURN new_id;
END
$$;
