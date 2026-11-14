-- A run that quotes other work takes what that work carries. Its own person's work passes on its
-- reasons in its words; another person's only that it read such material, never why.
CREATE FUNCTION gov._quote_run(p_run uuid, p_quoted uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me record;
  q record;
  mine boolean;
  private_reason text;
BEGIN
  SELECT r.task_id, gov._run_person(r.id) AS person INTO me FROM app.runs r WHERE r.workspace_id = ws AND r.id = p_run;
  SELECT r.*, gov._run_person(r.id) AS person INTO q FROM app.runs r WHERE r.workspace_id = ws AND r.id = p_quoted;
  IF NOT FOUND OR p_quoted = p_run OR NOT (q.tainted_untrusted OR q.tainted_sensitive) THEN
    RETURN;
  END IF;
  mine := q.person = me.person;
  private_reason := coalesce(q.elsewhere_source, q.sensitive_source);
  PERFORM gov._mark(p_run,
    CASE WHEN q.tainted_untrusted THEN CASE WHEN mine
      THEN 'other work it quoted, which had read ' || gov._strip_carried(q.untrusted_source)
      ELSE 'other work it quoted, for another person, which had read content from outside the workspace' END END,
    CASE WHEN q.tainted_sensitive THEN CASE WHEN mine
      THEN 'other work it quoted, which had read ' || gov._strip_carried(private_reason)
      ELSE 'other work it quoted, for another person, which had read private material' END END,
    CASE WHEN q.tainted_sensitive AND (NOT mine OR q.task_id IS DISTINCT FROM me.task_id) THEN CASE WHEN mine
      THEN 'other work it quoted, which had read ' || gov._strip_carried(private_reason)
      ELSE 'other work it quoted, for another person, which had read private material' END END);
END
$$;
