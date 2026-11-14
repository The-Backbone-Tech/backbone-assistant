-- Restrictive project checks retain legacy crossings and the run-secret accounting exception.
CREATE FUNCTION gov.identity_run_access(p_run uuid,p_write boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE task uuid;
BEGIN
  SELECT task_id INTO task FROM app.runs WHERE workspace_id=sec.current_workspace() AND id=p_run;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN gov.identity_task_access(task,p_write);
END
$$;
REVOKE ALL ON FUNCTION gov.identity_run_access(uuid,boolean) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_run_access(uuid,boolean) TO backbone_app,backbone_owner;
