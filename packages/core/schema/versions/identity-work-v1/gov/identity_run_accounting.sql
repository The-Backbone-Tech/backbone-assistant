-- Restrictive project checks retain legacy crossings and the run-secret accounting exception.
CREATE FUNCTION gov.identity_run_accounting(p_run uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  IF NOT sec.names_run() OR p_run IS DISTINCT FROM nullif(current_setting('backbone.run',true),'')::uuid THEN RETURN false; END IF;
  RETURN EXISTS(SELECT FROM app.runs r JOIN ops.run_secrets s ON s.workspace_id=r.workspace_id AND s.run_id=r.id AND s.fence=r.fence
    WHERE r.workspace_id=sec.current_workspace() AND r.id=p_run AND s.secret_hash=encode(sha256(convert_to(coalesce(current_setting('backbone.secret',true),''),'UTF8')),'hex'));
END
$$;
REVOKE ALL ON FUNCTION gov.identity_run_accounting(uuid) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_run_accounting(uuid) TO backbone_app,backbone_owner;
