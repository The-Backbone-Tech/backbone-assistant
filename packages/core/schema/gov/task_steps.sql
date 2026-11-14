-- A task's steps as the session is shown them: a step of work that kept its work shows others only
-- that it happened; its person reads its title and summary.
CREATE FUNCTION gov.task_steps(p_task uuid) RETURNS TABLE (run_id uuid, seq integer, title text, summary text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT s.run_id, s.seq,
         CASE WHEN gov._run_kept(r.id) AND gov._run_person(r.id) IS DISTINCT FROM sec.viewer()
              THEN 'A step of work kept for ' || gov._person_name(gov._run_person(r.id)) ELSE s.title END,
         CASE WHEN gov._run_kept(r.id) AND gov._run_person(r.id) IS DISTINCT FROM sec.viewer()
              THEN NULL ELSE s.output ->> 'summary' END
  FROM app.run_steps s JOIN app.runs r ON r.workspace_id = s.workspace_id AND r.id = s.run_id
  WHERE s.workspace_id = sec.current_workspace() AND r.task_id = p_task AND sec.task_visible(p_task)
  ORDER BY s.run_id, s.seq
$$;
