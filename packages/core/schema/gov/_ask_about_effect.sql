-- Open the question an effect waits on, put to the checker its reason names: above the ceiling or
-- final, the person the work is for; an elevation, any owner or admin outside the proposer's
-- delegation tree; the rule of two, the verifier, or in its place the person whose material it is;
-- an undo above its person's role, another owner or admin.
CREATE FUNCTION gov._ask_about_effect(p_effect uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  e record;
  kind text := 'person';
  checker uuid;
  v_strict boolean := false;
BEGIN
  SELECT * INTO e FROM app.effects x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_effect;
  CASE e.route_reason
    WHEN 'elevation' THEN v_strict := true;
    WHEN 'above_role' THEN v_strict := false;
    WHEN 'rule_of_two' THEN
      kind := CASE WHEN gov._has_verifier() THEN 'verifier' ELSE 'person' END;
      checker := e.on_behalf_of_id;
    ELSE checker := e.on_behalf_of_id;
  END CASE;
  RETURN gov._open_decision('effect', p_effect, e.proposer_id, e.on_behalf_of_id, e.route_reason, e.args_hash,
                            gov._effect_question(p_effect, checker), v_strict, kind, checker);
END
$$;
