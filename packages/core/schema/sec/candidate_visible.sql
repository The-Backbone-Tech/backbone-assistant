-- A knowledge candidate is seen by the workspace's people and by verifiers; one kept for its person
-- (proposed by work marked both ways) only by that person, its proposer and the verifier.
CREATE FUNCTION sec.candidate_visible(p_candidate uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT FROM app.knowledge_candidates c
    WHERE c.workspace_id = sec.current_workspace() AND c.id = p_candidate
      AND (NOT c.kept
           OR sec.viewer() IN (c.on_behalf_of, c.proposed_by)
           OR sec.viewer() = sec.system_principal()
           OR sec.is_verifier(sec.current_principal())))
$$;
