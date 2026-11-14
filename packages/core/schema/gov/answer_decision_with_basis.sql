-- The released four-argument crossing remains unchanged. This exact profile records checked basis.
CREATE FUNCTION gov.answer_decision_with_basis(p_decision uuid, p_proposal_hash text, p_verdict text, p_note text,
  p_basis jsonb DEFAULT '{"method":"person"}'::jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  me uuid := sec.current_principal();
  d record;
  e record;
  s record;
  signature uuid;
BEGIN
  IF sec.names_run() THEN RAISE EXCEPTION 'not_by_runs: a question is never answered from inside a run'; END IF;
  IF me IS NULL THEN RAISE EXCEPTION 'no_identity: the session acts as nobody'; END IF;
  IF sec.principal_kind(me) <> 'person' THEN RAISE EXCEPTION 'role: only a person states an answer basis'; END IF;
  PERFORM gov._lock_workspace();
  SELECT x.* INTO d FROM app.decisions x WHERE x.workspace_id=sec.current_workspace() AND x.id=p_decision FOR UPDATE;
  IF NOT FOUND OR d.status<>'open' THEN RAISE EXCEPTION 'not_open: the question is not open'; END IF;
  IF p_proposal_hash IS DISTINCT FROM d.proposal_hash THEN RAISE EXCEPTION 'different_proposal: another proposal was named'; END IF;
  IF p_verdict IS NULL OR p_verdict NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'invalid: a verdict is approved or rejected'; END IF;
  IF p_basis IS NULL OR jsonb_typeof(p_basis)<>'object' OR p_basis->>'method' IS NULL THEN
    RAISE EXCEPTION 'invalid: an answer states a structured basis';
  END IF;
  IF p_basis->>'method'='person' THEN
    IF p_basis <> '{"method":"person"}'::jsonb THEN RAISE EXCEPTION 'invalid: person basis has no other fields'; END IF;
  ELSIF p_basis->>'method'='standing_signature' THEN
    IF p_verdict<>'approved' OR d.subject_kind<>'effect' THEN
      RAISE EXCEPTION 'invalid: a standing signature approves only a connector effect';
    END IF;
    IF jsonb_typeof(p_basis->'signature') IS DISTINCT FROM 'string'
       OR (p_basis-'method'-'signature')<>'{}'::jsonb THEN
      RAISE EXCEPTION 'invalid: a standing basis names only its signature';
    END IF;
    BEGIN signature := (p_basis->>'signature')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'invalid: a signature is a UUID'; END;
    SELECT x.* INTO s FROM app.connector_signatures x WHERE x.workspace_id=sec.current_workspace() AND x.id=signature;
    IF NOT FOUND THEN RAISE EXCEPTION 'not_found: no such signature in this workspace'; END IF;
    IF s.person_id IS DISTINCT FROM me THEN RAISE EXCEPTION 'someone_else: the signature belongs to another person'; END IF;
    IF s.ended_at IS NOT NULL THEN RAISE EXCEPTION 'revoked: the signature has ended'; END IF;
    SELECT x.* INTO e FROM app.effects x WHERE x.workspace_id=sec.current_workspace() AND x.id=d.subject_id FOR UPDATE;
    IF NOT FOUND OR e.operation NOT LIKE 'mcp.%' OR e.connection_id IS NULL THEN
      RAISE EXCEPTION 'invalid: this decision is not about a connector effect';
    END IF;
    IF s.connection_id IS DISTINCT FROM e.connection_id OR s.operation IS DISTINCT FROM e.operation THEN
      RAISE EXCEPTION 'denied: the signature covers another connector tool';
    END IF;
    IF NOT EXISTS (SELECT FROM app.connection_tools t WHERE t.workspace_id=sec.current_workspace()
        AND t.connection_id=s.connection_id AND t.name=s.tool_name AND t.removed_at IS NULL) THEN
      RAISE EXCEPTION 'revoked: the signed connector tool was removed';
    END IF;
    -- Canonical UUID spelling; callers cannot smuggle another representation into the ledger.
    p_basis := jsonb_build_object('method','standing_signature','signature',signature);
  ELSE RAISE EXCEPTION 'invalid: unknown answer basis method';
  END IF;
  PERFORM gov._may_answer(p_decision,me,p_verdict);
  PERFORM gov._settle_decision_with_basis(p_decision,p_verdict,me,p_note,p_basis);
  RETURN p_verdict;
END
$$;
