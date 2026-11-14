-- A decision is an explicit capability for its exact proposal. An admin role is not.
CREATE FUNCTION gov.identity_effect_decider_access(p_decision uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
  SELECT NOT sec.names_run() AND sec.current_principal() IS NOT NULL AND EXISTS(
    SELECT FROM app.decisions d WHERE d.workspace_id=sec.current_workspace() AND d.id=p_decision
      AND (d.checker_id=sec.viewer() OR (d.checker_kind='verifier' AND sec.is_verifier(sec.current_principal()))))
$$;
REVOKE ALL ON FUNCTION gov.identity_effect_decider_access(uuid) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_effect_decider_access(uuid) TO backbone_app,backbone_owner;
