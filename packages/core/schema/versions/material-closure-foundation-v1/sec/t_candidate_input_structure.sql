-- Material closure foundation v1. Canonical versioned source; see its closed manifest.
CREATE FUNCTION sec.t_candidate_input_structure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  candidate app.knowledge_candidates%ROWTYPE;
  proof app.knowledge_candidate_inputs%ROWTYPE;
  boundary app.ledger%ROWTYPE;
  captured app.ledger%ROWTYPE;
  proposal app.ledger%ROWTYPE;
  entries bigint;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_TABLE_SCHEMA <> 'app' OR TG_TABLE_NAME <> 'knowledge_candidates' THEN
    RAISE EXCEPTION 'invalid: candidate input validation belongs only to candidate insertion';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'paused: candidate input validation requires READ COMMITTED isolation';
  END IF;
  -- These tenant-walled reads require the original workspace at validation. Do not manufacture
  -- another workspace context, or use the current principal as the historical creation actor.
  IF NEW.workspace_id IS DISTINCT FROM sec.current_workspace() THEN
    RAISE EXCEPTION 'paused: candidate input validation requires its original workspace';
  END IF;
  PERFORM gov._lock_workspace();
  SELECT c.* INTO candidate FROM app.knowledge_candidates c
  WHERE c.workspace_id = NEW.workspace_id AND c.id = NEW.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'paused: the candidate row is missing at input validation';
  END IF;
  SELECT p.* INTO proof FROM app.knowledge_candidate_inputs p
  WHERE p.workspace_id = candidate.workspace_id AND p.candidate_id = candidate.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'paused: the candidate has no native input proof';
  END IF;
  IF proof.format_version IS DISTINCT FROM 1
     OR proof.proposed_by IS DISTINCT FROM candidate.proposed_by
     OR proof.run_id IS DISTINCT FROM candidate.run_id
     OR proof.on_behalf_of IS DISTINCT FROM candidate.on_behalf_of
     OR proof.words_untrusted IS DISTINCT FROM candidate.words_untrusted
     OR proof.kept IS DISTINCT FROM candidate.kept
     OR proof.claim_digest IS DISTINCT FROM gov._candidate_claim_digest_v1(candidate)
     OR proof.input_sha256 IS DISTINCT FROM encode(sha256(convert_to(proof.input_manifest::text, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'paused: candidate input proof does not bind its immutable claim';
  END IF;
  SELECT count(*) INTO entries FROM app.ledger l
  WHERE l.workspace_id = candidate.workspace_id AND l.entry_type = 'knowledge.dependencies_enabled';
  IF entries <> 1 THEN
    RAISE EXCEPTION 'paused: the candidate workspace has no unique native input boundary';
  END IF;
  SELECT l.* INTO boundary FROM app.ledger l
  WHERE l.workspace_id = candidate.workspace_id AND l.seq = proof.boundary_seq;
  IF NOT FOUND OR boundary.entry_type IS DISTINCT FROM 'knowledge.dependencies_enabled'
     OR boundary.subject IS NOT NULL
     OR boundary.payload IS DISTINCT FROM jsonb_build_object('version', 'material-closure-foundation-v1')
     OR boundary.hash IS DISTINCT FROM proof.boundary_hash
     OR proof.capture_seq < proof.boundary_seq THEN
    RAISE EXCEPTION 'paused: candidate input proof has a mismatched native boundary';
  END IF;
  SELECT l.* INTO captured FROM app.ledger l
  WHERE l.workspace_id = candidate.workspace_id AND l.seq = proof.capture_seq;
  IF NOT FOUND OR captured.hash IS DISTINCT FROM proof.capture_hash THEN
    RAISE EXCEPTION 'paused: candidate input proof has no matching captured ledger head';
  END IF;
  SELECT count(*) INTO entries FROM app.ledger l
  WHERE l.workspace_id = candidate.workspace_id AND l.entry_type = 'knowledge.proposed'
    AND l.subject = candidate.id::text;
  IF entries <> 1 THEN
    RAISE EXCEPTION 'paused: the candidate requires exactly one matching proposal event';
  END IF;
  SELECT l.* INTO proposal FROM app.ledger l
  WHERE l.workspace_id = candidate.workspace_id AND l.seq = proof.proposal_seq;
  IF NOT FOUND OR proposal.entry_type IS DISTINCT FROM 'knowledge.proposed'
     OR proposal.subject IS DISTINCT FROM candidate.id::text
     OR proposal.actor_id IS DISTINCT FROM proof.proposed_by
     OR proposal.prev_hash IS DISTINCT FROM proof.capture_hash
     OR proposal.hash IS DISTINCT FROM sec.ledger_hash(proposal.prev_hash, proposal.workspace_id,
       proposal.seq, proposal.entry_type, proposal.actor_id, proposal.subject, proposal.payload, proposal.at) THEN
    RAISE EXCEPTION 'paused: the proposal event does not immediately follow its native input cut';
  END IF;
  -- The released body digests raw p_topic; NULL becomes stored topic 'general' but event topic
  -- JSON null. Accept exactly those two encodings of the same stored general topic.
  IF proposal.payload IS DISTINCT FROM jsonb_build_object('run', proof.run_id, 'topic', sec.digest(candidate.topic))
     AND NOT (candidate.topic = 'general'
       AND proposal.payload IS NOT DISTINCT FROM jsonb_build_object('run', proof.run_id, 'topic', NULL::text)) THEN
    RAISE EXCEPTION 'paused: the proposal payload does not bind its native run and topic';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION sec.t_candidate_input_structure()
  FROM PUBLIC, backbone_app, backbone_operator;
GRANT EXECUTE ON FUNCTION sec.t_candidate_input_structure() TO backbone_owner;
