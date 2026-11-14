-- Material closure foundation v1. Canonical versioned source; see its closed manifest.
CREATE FUNCTION gov._knowledge_personal_closure_v1(p_candidate uuid, p_receiver uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  unavailable jsonb := jsonb_build_object('format','candidate-personal-closure-v1','state','unknown');
  roots jsonb;
  immutable_sources jsonb;
  expected_manifest jsonb;
  c app.knowledge_candidates%ROWTYPE;
  proof app.knowledge_candidate_inputs%ROWTYPE;
  boundary app.ledger%ROWTYPE;
  captured app.ledger%ROWTYPE;
  proposal app.ledger%ROWTYPE;
  entries bigint;
  has_proof boolean;
BEGIN
  roots := gov._personal_message_roots_v1(p_candidate, p_receiver);
  IF roots ->> 'state' IS DISTINCT FROM 'known_personal_roots' THEN
    RETURN unavailable || jsonb_build_object('reason','personal_roots_unknown');
  END IF;
  SELECT * INTO c FROM app.knowledge_candidates x WHERE x.workspace_id=ws AND x.id=p_candidate;
  IF NOT FOUND OR roots ->> 'claim_digest' IS NULL
     OR roots ->> 'claim_digest' !~ '^[a-f0-9]{64}$'
     OR roots ->> 'claim_digest' IS DISTINCT FROM gov._candidate_claim_digest_v1(c) THEN
    RETURN unavailable || jsonb_build_object('reason','claim_binding_unknown');
  END IF;
  -- This family is explicitly MESSAGE only. Adding WEB requires its own native positive
  -- producer proof; an allowlist entry alone never certifies an exact native source.
  IF EXISTS (SELECT FROM jsonb_array_elements(roots -> 'roots') r
             WHERE r ->> 'source_kind' IS DISTINCT FROM 'message') THEN
    RETURN unavailable || jsonb_build_object('reason','unsupported_source_kind');
  END IF;
  SELECT count(*) INTO entries FROM app.ledger l
  WHERE l.workspace_id=ws AND l.entry_type='knowledge.dependencies_enabled';
  IF entries <> 1 THEN
    RETURN unavailable || jsonb_build_object('reason','boundary_unknown');
  END IF;
  SELECT * INTO boundary FROM app.ledger l
  WHERE l.workspace_id=ws AND l.entry_type='knowledge.dependencies_enabled';
  IF boundary.subject IS NOT NULL
     OR boundary.payload IS DISTINCT FROM jsonb_build_object('version','material-closure-foundation-v1')
     OR boundary.hash IS DISTINCT FROM sec.ledger_hash(boundary.prev_hash,ws,boundary.seq,
       boundary.entry_type,boundary.actor_id,boundary.subject,boundary.payload,boundary.at)
     OR NOT EXISTS (SELECT FROM app.ledger l WHERE l.workspace_id=ws
       AND l.seq=boundary.seq-1 AND l.hash=boundary.prev_hash) THEN
    RETURN unavailable || jsonb_build_object('reason','boundary_binding_unknown');
  END IF;
  -- Frozen roots already require the unique real proposal event and its exact claim,
  -- own hash and predecessor. Re-select by that identity, never parse a reason string.
  SELECT * INTO proposal FROM app.ledger l WHERE l.workspace_id=ws
    AND l.entry_type='knowledge.proposed' AND l.subject=c.id::text;
  IF NOT FOUND OR proposal.seq::text IS DISTINCT FROM roots ->> 'proposal_seq' THEN
    RETURN unavailable || jsonb_build_object('reason','proposal_binding_unknown');
  END IF;
  SELECT * INTO proof FROM app.knowledge_candidate_inputs p
    WHERE p.workspace_id=ws AND p.candidate_id=c.id;
  has_proof := FOUND;
  IF NOT has_proof THEN
    IF proposal.seq >= boundary.seq THEN
      RETURN unavailable || jsonb_build_object('reason','post_boundary_proof_missing');
    END IF;
    -- A legacy standalone personal declaration has a positively demonstrated native cut.
    -- This derives a present read snapshot; it never backfills a creation-time proof.
    RETURN jsonb_build_object('format','candidate-personal-closure-v1',
      'state','known_personal_closure','basis','legacy_exact_native_cut',
      'boundary_seq',boundary.seq::text,'boundary_hash',boundary.hash,
      'proof',NULL,'roots',roots);
  END IF;
  IF proof.format_version IS DISTINCT FROM 1 OR proof.boundary_seq <> boundary.seq
     OR proof.boundary_hash IS DISTINCT FROM boundary.hash
     OR proof.capture_seq < boundary.seq OR proof.proposal_seq <> proposal.seq
     OR proposal.seq <> proof.capture_seq+1
     OR proof.proposed_by IS DISTINCT FROM c.proposed_by
     OR proof.run_id IS NOT NULL OR proof.run_fence IS NOT NULL OR proof.run_task_id IS NOT NULL
     OR proof.run_tainted_untrusted IS NOT NULL OR proof.run_tainted_sensitive IS NOT NULL
     OR proof.on_behalf_of IS DISTINCT FROM c.on_behalf_of
     OR proof.words_untrusted IS DISTINCT FROM c.words_untrusted
     OR proof.kept IS DISTINCT FROM c.kept
     OR proof.claim_digest IS DISTINCT FROM roots ->> 'claim_digest'
     OR proof.input_sha256 IS DISTINCT FROM encode(sha256(convert_to(proof.input_manifest::text,'UTF8')),'hex') THEN
    RETURN unavailable || jsonb_build_object('reason','native_proof_binding_unknown');
  END IF;
  SELECT * INTO captured FROM app.ledger l WHERE l.workspace_id=ws AND l.seq=proof.capture_seq;
  IF NOT FOUND OR captured.hash IS DISTINCT FROM proof.capture_hash
     OR captured.hash IS DISTINCT FROM sec.ledger_hash(captured.prev_hash,ws,captured.seq,
       captured.entry_type,captured.actor_id,captured.subject,captured.payload,captured.at)
     OR NOT EXISTS (SELECT FROM app.ledger l WHERE l.workspace_id=ws
       AND l.seq=captured.seq-1 AND l.hash=captured.prev_hash)
     OR proposal.prev_hash IS DISTINCT FROM captured.hash THEN
    RETURN unavailable || jsonb_build_object('reason','native_capture_cut_unknown');
  END IF;
  -- The original native BEFORE guard authenticated the active proposer and their audience
  -- AT CAPTURE. Do not replay those mutable admissions against today's proposer status.
  -- The full native roots result above independently enforces TODAY'S receiving person,
  -- visibility and sensitivity and validates each immutable message/episode/event/claim.
  -- Its positive proposal cut is now structurally bound to original H+1. Keep every root,
  -- explicitly require both actual source/message cuts <= H, and normalise ONLY the
  -- current sensitivity field out of the historical comparison. No caller JSON is used.
  IF jsonb_array_length(roots -> 'roots') NOT BETWEEN 1 AND 64
     OR EXISTS (SELECT FROM jsonb_array_elements(roots -> 'roots') source
       WHERE (source ->> 'message_seq')::bigint < 1
         OR (source ->> 'source_seq')::bigint < 1
         OR (source ->> 'message_seq')::bigint > proof.capture_seq
         OR (source ->> 'source_seq')::bigint > proof.capture_seq
         OR (source ->> 'message_seq')::bigint >= (source ->> 'source_seq')::bigint) THEN
    RETURN unavailable || jsonb_build_object('reason','personal_proof_inputs_unknown',
      'detail','original_native_source_cut_not_demonstrated');
  END IF;
  SELECT jsonb_agg(source - 'currently_sensitive'
    ORDER BY (source ->> 'episode_id') COLLATE "C") INTO immutable_sources
    FROM jsonb_array_elements(roots -> 'roots') source;
  expected_manifest := jsonb_build_object('version',1,'complete',true,
    'sources',immutable_sources,'read_edges','[]'::jsonb,'unknown','[]'::jsonb);
  -- Shape/hash/complete=true alone is NEVER sufficient. Compare the entire stored proof
  -- to native source rederivation; extra omitted/unsupported dependencies cannot disappear.
  IF proof.input_manifest IS DISTINCT FROM expected_manifest THEN
    RETURN unavailable || jsonb_build_object('reason','personal_proof_manifest_unknown');
  END IF;
  RETURN jsonb_build_object('format','candidate-personal-closure-v1',
    'state','known_personal_closure','basis','native_before_personal_proof',
    'boundary_seq',boundary.seq::text,'boundary_hash',boundary.hash,
    'proof',jsonb_build_object('candidate_id',proof.candidate_id,
      'format_version',proof.format_version,'claim_digest',proof.claim_digest,
      'capture_seq',proof.capture_seq::text,'capture_hash',proof.capture_hash,
      'proposal_seq',proof.proposal_seq::text,'input_sha256',proof.input_sha256,
      'input_manifest',proof.input_manifest),
    'roots',roots);
END
$$;
ALTER FUNCTION gov._knowledge_personal_closure_v1(uuid,uuid) OWNER TO backbone_gov;
REVOKE ALL ON FUNCTION gov._knowledge_personal_closure_v1(uuid,uuid)
  FROM PUBLIC,backbone_app,backbone_operator;
