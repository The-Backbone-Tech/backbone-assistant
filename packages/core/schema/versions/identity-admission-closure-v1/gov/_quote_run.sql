-- A run that quotes other work takes what that work carries. Its own person's work passes on its
-- reasons in its words; another person's only that it read such material, never why.
CREATE OR REPLACE FUNCTION gov._quote_run(p_run uuid, p_quoted uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  old_person text:=coalesce(current_setting('backbone.principal',true),''); old_run text:=coalesce(current_setting('backbone.run',true),''); old_secret text:=coalesce(current_setting('backbone.secret',true),'');
  ws uuid := sec.current_workspace();
  me record;
  q record;
  mine boolean;
  private_reason text;
BEGIN
  PERFORM set_config('backbone.run','',true); PERFORM set_config('backbone.secret','',true); PERFORM set_config('backbone.principal',sec.system_principal()::text,true);
  SELECT r.task_id, gov._run_person(r.id) AS person INTO me FROM app.runs r WHERE r.workspace_id = ws AND r.id = p_run;
  SELECT r.*, gov._run_person(r.id) AS person INTO q FROM app.runs r WHERE r.workspace_id = ws AND r.id = p_quoted;
  IF NOT FOUND OR p_quoted = p_run OR NOT (q.tainted_untrusted OR q.tainted_sensitive) THEN
    PERFORM set_config('backbone.principal',old_person,true); PERFORM set_config('backbone.run',old_run,true); PERFORM set_config('backbone.secret',old_secret,true);
    RETURN;
  END IF;
  mine := q.person = me.person AND gov.identity_person_task_access(q.task_id,me.person,false);
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
  PERFORM set_config('backbone.principal',old_person,true); PERFORM set_config('backbone.run',old_run,true); PERFORM set_config('backbone.secret',old_secret,true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('backbone.principal',old_person,true); PERFORM set_config('backbone.run',old_run,true); PERFORM set_config('backbone.secret',old_secret,true);
  RAISE;
END
$$;
