-- Effects are already restricted to a live grant or the exact decision capability.
-- This reveals only a run associated with a question the caller may decide.
CREATE FUNCTION gov.identity_run_decider_access(p_run uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
  SELECT NOT sec.names_run() AND sec.current_principal() IS NOT NULL AND EXISTS(
    SELECT FROM app.effects e WHERE e.workspace_id=sec.current_workspace() AND e.run_id=p_run
      AND gov.identity_effect_decider_access(e.decision_id))
$$;
REVOKE ALL ON FUNCTION gov.identity_run_decider_access(uuid) FROM PUBLIC,backbone_app,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_run_decider_access(uuid) TO backbone_owner;
