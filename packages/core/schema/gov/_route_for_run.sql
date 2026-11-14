-- Route a run's proposed act by the kernel's table, with the run's marks as its taint.
-- A read's outbound arguments count as fixed only when it sends none at all ('{}'): anything else
-- is the model's, whatever account it uses. Writing a document is publishing unless its task is read
-- by nobody but the run's person: a run marked both ways then needs a checker too. The dispatcher
-- checks that audience again, under lock, when it writes (gov.write_document_by_effect).
CREATE FUNCTION gov._route_for_run(
  p_run uuid, p_class smallint, p_standing text, p_ceiling smallint, p_external boolean, p_operation text, p_args jsonb,
  p_connection uuid
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  r record;
  target_task uuid;
  person uuid;
  routed text;
BEGIN
  SELECT * INTO r FROM app.runs x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_run;
  routed := sec.route_effect(p_class, p_standing, p_ceiling, r.tainted_untrusted, r.tainted_sensitive, p_external, p_args = '{}'::jsonb);
  IF routed = 'allowed' AND p_operation = 'workspace.write_document' AND r.tainted_untrusted AND r.tainted_sensitive THEN
    SELECT d.task_id INTO target_task FROM app.documents d
    WHERE d.workspace_id = r.workspace_id AND d.id::text = p_args ->> 'document_id';
    IF NOT FOUND THEN
      target_task := nullif(p_args ->> 'task_id', '')::uuid;
    END IF;
    person := gov._run_person(p_run);
    -- The run's own task gets no exemption: it is private only while nobody but its person reads it.
    IF target_task IS NULL OR gov._task_read_beyond(target_task, person) OR NOT EXISTS (
         SELECT FROM app.tasks t WHERE t.workspace_id = r.workspace_id AND t.id = target_task
           AND t.requested_by = person AND t.on_behalf_of = person) THEN
      routed := 'needs_checker:rule_of_two';
    END IF;
  END IF;
  RETURN routed;
END
$$;
