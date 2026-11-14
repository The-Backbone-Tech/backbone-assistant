-- The proposer asks for its candidate to be promoted, under terms set now and once: the member of
-- the workspace who will own the knowledge, and when it holds. Its evidence must be found verbatim
-- in its sources, and what an agent wrote (or the proposer itself) is not evidence. One question
-- is opened, for a checker independent of the proposer's whole delegation tree (I-9): the
-- verifier, or without one any independent owner or admin. The same proposal already rejected is
-- not asked again.
CREATE FUNCTION gov.request_promotion(p_candidate uuid, p_owner uuid, p_valid_from timestamptz, p_valid_to timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := sec.current_principal();
  c record;
  owner record;
  ev record;
  terms text;
  kind text;
  question text;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no_identity: the session acts as nobody';
  END IF;
  PERFORM gov._lock_workspace();
  SELECT * INTO c FROM app.knowledge_candidates x WHERE x.workspace_id = ws AND x.id = p_candidate FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such candidate in this workspace';
  END IF;
  IF c.proposed_by <> me THEN
    RAISE EXCEPTION 'denied: promotion is requested by the candidate''s proposer';
  END IF;
  IF c.status <> 'open' THEN
    RAISE EXCEPTION 'not_open: the candidate is closed';
  END IF;
  SELECT * INTO owner FROM app.principals p WHERE p.workspace_id = ws AND p.id = p_owner;
  IF NOT FOUND OR owner.kind <> 'person' OR owner.role NOT IN ('owner', 'admin', 'member') OR owner.status <> 'active' THEN
    RAISE EXCEPTION 'not_member: knowledge is owned by a member of the workspace';
  END IF;
  -- Preserve the established invalid/self-evidence refusal before the temporary source pause.
  FOR ev IN SELECT x ->> 'excerpt' AS excerpt, e.* FROM jsonb_array_elements(c.evidence) x
            JOIN app.episodes e ON e.workspace_id = ws AND e.id::text = x ->> 'episode' LOOP
    IF ev.excerpt IS NULL OR length(ev.excerpt) = 0 OR position(ev.excerpt IN ev.content) = 0 THEN
      RAISE EXCEPTION 'not_verbatim: the evidence is not found verbatim in its source';
    END IF;
    IF ev.source_kind = 'sandbox' OR ev.authored_by = me OR sec.principal_kind(ev.authored_by) IN ('agent', 'system') THEN
      RAISE EXCEPTION 'self_evidence: what an agent wrote, or what the proposer wrote, is not evidence';
    END IF;
  END LOOP;
  IF NOT gov._promotion_sources_allowed(p_candidate) THEN
    RAISE EXCEPTION 'paused: promotion awaits source withdrawal verification';
  END IF;
  terms := sec.args_hash(jsonb_build_object(
    'statement', c.statement, 'topic', c.topic, 'evidence', c.evidence, 'owner', p_owner,
    'valid_from', to_char(p_valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'valid_to', to_char(p_valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
  IF c.terms_hash IS NOT NULL THEN
    IF c.terms_hash <> terms THEN
      RAISE EXCEPTION 'frozen: the candidate''s terms were set by its first request';
    END IF;
    RAISE EXCEPTION 'conflict: there is already an open question about this candidate';
  END IF;
  IF EXISTS (SELECT FROM app.knowledge_candidates x WHERE x.workspace_id = ws AND x.status = 'rejected' AND x.terms_hash = terms) THEN
    RAISE EXCEPTION 'already_rejected: the same proposal was already rejected';
  END IF;
  UPDATE app.knowledge_candidates SET owner_id = p_owner, valid_from = p_valid_from, valid_to = p_valid_to, terms_hash = terms
  WHERE workspace_id = ws AND id = p_candidate;
  kind := CASE WHEN gov._has_verifier() THEN 'verifier' ELSE 'person' END;
  question := 'Accept into knowledge: ' || c.statement || '.';
  IF c.kept THEN
    question := question || ' The work that proposed it read untrusted content and private material: only '
                || (SELECT p.name FROM app.principals p WHERE p.workspace_id = ws AND p.id = c.on_behalf_of) || ' and the verifier see it.';
  END IF;
  RETURN gov._open_decision('promotion', p_candidate, me, c.on_behalf_of, CASE WHEN c.kept THEN 'rule_of_two' ELSE 'promotion' END,
                            terms, question, true, kind, CASE WHEN c.kept THEN c.on_behalf_of END);
END
$$;
