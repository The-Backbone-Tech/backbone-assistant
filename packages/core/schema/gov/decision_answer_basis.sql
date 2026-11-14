-- Null means unanswered. Missing historical basis is never inferred from a later actor.
CREATE FUNCTION gov.decision_answer_basis(p_decision uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN l.payload->'basis'->>'method' = 'standing_signature' THEN l.payload->'basis'
    WHEN l.payload->'basis' IS NULL AND EXISTS (
      SELECT FROM app.ledger boundary WHERE boundary.workspace_id=l.workspace_id
        AND boundary.entry_type='decision.basis_enabled' AND boundary.seq>l.seq)
      THEN jsonb_build_object('method','basis_not_recorded')
    ELSE jsonb_build_object('method',CASE
      WHEN l.payload->'basis' IS NOT NULL AND l.payload->'basis'->>'method' IS DISTINCT FROM 'person' THEN 'not_stated'
      WHEN p.kind='person' THEN 'person'
      WHEN p.kind='agent' AND p.agent_role='verifier' THEN 'verifier'
      ELSE 'not_stated' END)
    END
  FROM app.ledger l
  LEFT JOIN app.principals p ON p.workspace_id=l.workspace_id AND p.id=l.actor_id
  WHERE l.workspace_id=sec.current_workspace() AND l.subject=p_decision::text
    AND l.entry_type='decision.answered' AND sec.decision_visible(p_decision)
  ORDER BY l.seq LIMIT 1
$$;
