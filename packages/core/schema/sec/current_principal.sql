-- Who the session acts as. Naming a run makes the run's agent the principal, or nobody when the run
-- is not held: the principal the session also names is then ignored. Otherwise the named principal,
-- if it is an active principal of the session's workspace.
CREATE FUNCTION sec.current_principal() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN sec.names_run() THEN (SELECT r.agent_id FROM app.runs r WHERE r.workspace_id = sec.current_workspace() AND r.id = sec.current_run())
    ELSE (SELECT p.id FROM app.principals p
          WHERE p.workspace_id = sec.current_workspace()
            AND p.id = nullif(current_setting('backbone.principal', true), '')::uuid
            AND p.status = 'active')
  END
$$;
