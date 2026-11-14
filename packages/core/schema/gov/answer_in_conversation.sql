-- The run, while it acts, answers in its task's conversation. An answer from work that kept its
-- work (untrusted content and private material from beyond this conversation), in a task others
-- read, is kept for its person: everyone else reads a pointer to it. Whatever a channel thread
-- bound to the task shows goes out to it.
CREATE FUNCTION gov.answer_in_conversation(p_task uuid, p_agent uuid, p_content text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  run uuid := sec.current_run();
  person uuid;
  answer uuid := gen_random_uuid();
  pointer uuid;
  kept boolean;
BEGIN
  IF run IS NULL THEN
    RAISE EXCEPTION 'not_in_run: a run answers only while it acts';
  END IF;
  IF NOT EXISTS (SELECT FROM app.runs r WHERE r.workspace_id = ws AND r.id = run AND r.task_id = p_task AND r.agent_id = p_agent) THEN
    RAISE EXCEPTION 'denied: a run answers in its own task, as its own agent';
  END IF;
  IF p_content IS NULL OR length(p_content) = 0 THEN
    RAISE EXCEPTION 'invalid: an answer has words';
  END IF;
  person := gov._run_person(run);
  kept := gov._run_kept(run) AND gov._task_read_beyond(p_task, person);
  INSERT INTO app.messages (workspace_id, id, task_id, run_id, role, author_id, content, only_for)
  VALUES (ws, answer, p_task, run, 'agent', p_agent, p_content, CASE WHEN kept THEN person END);
  IF kept THEN
    pointer := gen_random_uuid();
    INSERT INTO app.messages (workspace_id, id, task_id, run_id, role, author_id, content)
    VALUES (ws, pointer, p_task, NULL, 'system', NULL, 'An answer for ' || gov._person_name(person)
            || ' only: the work behind it read content from outside the workspace and private material from beyond this conversation, so it is not shown here.');
  END IF;
  INSERT INTO app.channel_messages (workspace_id, thread_id, message_id, direction)
  SELECT ws, ct.id, coalesce(pointer, answer), 'outbound' FROM app.channel_threads ct WHERE ct.workspace_id = ws AND ct.task_id = p_task;
  PERFORM gov._append('message.posted', answer::text, jsonb_build_object('task', p_task, 'role', 'agent', 'run', run, 'kept', kept));
  RETURN answer;
END
$$;
