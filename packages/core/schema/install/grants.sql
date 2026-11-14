-- What the service may execute: the published crossings and the helpers its policies evaluate.
-- Internal crossings (gov._*), the storage rules (sec.t_*) and the keyed digest stay closed to it.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA gov TO backbone_app;
DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'gov' AND p.proname LIKE '\_%'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM backbone_app', f);
  END LOOP;
END
$$;
GRANT EXECUTE ON FUNCTION
  sec.current_workspace(), sec.current_run(), sec.names_run(), sec.current_principal(), sec.session_is_empty(),
  sec.acting_for(), sec.viewer(), sec.system_principal(), sec.principal_kind(uuid), sec.role_of(uuid),
  sec.is_admin(uuid), sec.is_verifier(uuid), sec.task_visible(uuid), sec.run_visible(uuid), sec.effect_visible(uuid),
  sec.decision_visible(uuid), sec.candidate_visible(uuid), sec.visible_eligible_knowledge_sources(), sec.episode_visible(uuid, uuid),
  sec.args_hash(jsonb), sec.set_intersect(jsonb, jsonb), sec.set_within(jsonb, jsonb), sec.set_covers(jsonb, text),
  sec.terms_within(jsonb, jsonb), sec.mandate_terms(jsonb), sec.workspace_is_personal(uuid), sec.delegation_tree(uuid, uuid), sec.effect_transition_allowed(text, text), sec.attenuate(jsonb, jsonb),
  sec.route_effect(smallint, text, smallint, boolean, boolean, boolean, boolean),
  sec.checker_independent(uuid, uuid, uuid, boolean)
TO backbone_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA operator TO backbone_operator;
