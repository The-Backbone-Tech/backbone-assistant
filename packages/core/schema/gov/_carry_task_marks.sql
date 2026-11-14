-- A run starts with what its task's earlier work read: its own person's earlier runs pass on their
-- reasons in their words; another person's runs pass on only that they read such material.
CREATE FUNCTION gov._carry_task_marks(p_run uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me record;
  e record;
  mine boolean;
BEGIN
  SELECT r.*, m.on_behalf_of_id AS person INTO me FROM app.runs r
  JOIN app.mandates m ON m.workspace_id = r.workspace_id AND m.id = r.mandate_id
  WHERE r.workspace_id = sec.current_workspace() AND r.id = p_run;
  FOR e IN SELECT r.*, m.on_behalf_of_id AS person FROM app.runs r
           JOIN app.mandates m ON m.workspace_id = r.workspace_id AND m.id = r.mandate_id
           WHERE r.workspace_id = me.workspace_id AND r.task_id = me.task_id AND r.id <> p_run
             AND (r.tainted_untrusted OR r.tainted_sensitive OR r.elsewhere_source IS NOT NULL)
           ORDER BY r.created_at LOOP
    mine := e.person = me.person;
    PERFORM gov._mark(p_run,
      CASE WHEN e.tainted_untrusted THEN CASE WHEN mine
        THEN 'earlier work in this task, which read ' || gov._strip_carried(e.untrusted_source)
        ELSE 'earlier work in this task, for another of its people, which read content from outside the workspace' END END,
      CASE WHEN e.tainted_sensitive THEN CASE WHEN mine
        THEN 'earlier work in this task, which read ' || gov._strip_carried(e.sensitive_source)
        ELSE 'earlier work in this task, for another of its people, which read private material' END END,
      CASE WHEN e.elsewhere_source IS NOT NULL AND mine
        THEN 'earlier work in this task, which read ' || gov._strip_carried(e.elsewhere_source) END);
  END LOOP;
END
$$;
