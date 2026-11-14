-- Promotion itself, inside the approving answer and nowhere else (SG-PRO-01): the candidate
-- becomes accepted knowledge with exactly the terms that were approved.
CREATE FUNCTION gov._promote(p_candidate uuid, p_decision uuid, p_by uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  c record;
  new_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO c FROM app.knowledge_candidates x WHERE x.workspace_id = ws AND x.id = p_candidate FOR UPDATE;
  IF NOT gov._promotion_sources_allowed(p_candidate) THEN
    RAISE EXCEPTION 'paused: promotion awaits source withdrawal verification';
  END IF;
  INSERT INTO app.knowledge (workspace_id, id, candidate_id, decision_id, statement, topic, owner_id, valid_from, valid_to,
                             words_untrusted, accepted_by)
  VALUES (ws, new_id, p_candidate, p_decision, c.statement, c.topic, c.owner_id, c.valid_from, c.valid_to, c.words_untrusted, p_by);
  UPDATE app.knowledge_candidates SET status = 'accepted' WHERE workspace_id = ws AND id = p_candidate;
  PERFORM gov._append('knowledge.accepted', new_id::text, jsonb_build_object(
    'candidate', p_candidate, 'decision', p_decision, 'owner', c.owner_id), p_by);
  RETURN new_id;
END
$$;
