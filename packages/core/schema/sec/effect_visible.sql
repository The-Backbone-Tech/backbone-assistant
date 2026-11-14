-- An effect is seen by the system principal, by the person it is for, by a verifier asked about it,
-- and by whoever sees its task — unless its run kept its work (it read untrusted content and private
-- material from beyond its conversation): then only by its person and its decider. An undo is seen
-- as the effect it undoes.
CREATE FUNCTION sec.effect_visible(p_effect uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT FROM app.effects e
    WHERE e.workspace_id = sec.current_workspace() AND e.id = p_effect
      AND (sec.viewer() = sec.system_principal()
           OR e.on_behalf_of_id = sec.viewer()
           OR (NOT e.kept AND e.task_id IS NOT NULL AND sec.task_visible(e.task_id))
           OR (e.undo_of IS NOT NULL AND sec.effect_visible(e.undo_of))
           OR EXISTS (SELECT FROM app.decisions d
                      WHERE d.workspace_id = e.workspace_id AND d.id = e.decision_id
                        AND ((d.checker_kind = 'verifier' AND sec.is_verifier(sec.current_principal()))
                             OR d.checker_id = sec.viewer()))))
$$;
