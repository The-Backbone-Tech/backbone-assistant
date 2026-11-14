-- Material closure foundation v1. Canonical versioned source; see its closed manifest.
CREATE FUNCTION gov._personal_message_inputs_v1(p_claim app.knowledge_candidates, p_receiving_person uuid, p_capture_seq bigint)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  unavailable jsonb := jsonb_build_object('format', 'personal-message-inputs-v1', 'state', 'unknown');
  c app.knowledge_candidates%ROWTYPE;
  e app.episodes%ROWTYPE;
  m app.messages%ROWTYPE;
  task app.tasks%ROWTYPE;
  recording app.ledger%ROWTYPE;
  posting app.ledger%ROWTYPE;
  citation jsonb;
  roots jsonb := '[]'::jsonb;
  seen uuid[] := ARRAY[]::uuid[];
  episode_id uuid;
  message_id uuid;
  system_id uuid;
  matches bigint;
  ref_digest text;
  content_digest text;
  content_sha256 text;
  excerpt text;
  claim_digest text;
BEGIN
  IF ws IS NULL OR (p_claim).workspace_id IS DISTINCT FROM ws OR (p_claim).id IS NULL
     OR p_receiving_person IS NULL OR p_capture_seq IS NULL OR p_capture_seq < 1 THEN
    RETURN unavailable || jsonb_build_object('reason', 'missing_native_identity');
  END IF;
  IF NOT EXISTS (
    SELECT FROM app.principals p
    WHERE p.workspace_id = ws AND p.id = p_receiving_person
      AND p.kind = 'person' AND p.status = 'active'
  ) THEN
    RETURN unavailable || jsonb_build_object('reason', 'invalid_receiving_person');
  END IF;

  c := p_claim;
  -- Pre-proposal claim: no candidate/status/proposal lookup is allowed here.
  IF c.run_id IS NOT NULL THEN
    RETURN unavailable || jsonb_build_object('reason', 'run_lineage_not_demonstrated');
  END IF;
  IF c.on_behalf_of IS DISTINCT FROM c.proposed_by
     OR c.words_untrusted OR c.kept OR NOT EXISTS (
       SELECT FROM app.principals p WHERE p.workspace_id = ws AND p.id = c.proposed_by AND p.kind = 'person' AND p.status = 'active'
     ) THEN
    RETURN unavailable || jsonb_build_object('reason', 'not_a_personal_declaration');
  END IF;

  IF jsonb_typeof(c.evidence) IS DISTINCT FROM 'array' THEN
    RETURN unavailable || jsonb_build_object('reason', 'unsupported_citation_shape');
  END IF;
  -- Operational refusal, never a truncated proof. The final implementation must measure
  -- this bounded family; larger candidates stay UNKNOWN until deliberately supported.
  IF jsonb_array_length(c.evidence) NOT BETWEEN 1 AND 64 THEN
    RETURN unavailable || jsonb_build_object('reason', 'unsupported_citation_count');
  END IF;
  system_id := sec.system_principal();
  IF system_id IS NULL THEN
    RETURN unavailable || jsonb_build_object('reason', 'missing_system_recorder');
  END IF;

  FOR citation IN SELECT value FROM jsonb_array_elements(c.evidence) LOOP
    IF jsonb_typeof(citation) IS DISTINCT FROM 'object' THEN
      RETURN unavailable || jsonb_build_object('reason', 'unsupported_citation_shape');
    END IF;
    IF jsonb_typeof(citation -> 'episode') IS DISTINCT FROM 'string'
       OR jsonb_typeof(citation -> 'excerpt') IS DISTINCT FROM 'string'
       OR (SELECT count(*) FROM jsonb_object_keys(citation)) <> 2
       OR citation ->> 'episode' !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
      RETURN unavailable || jsonb_build_object('reason', 'unsupported_citation_shape');
    END IF;
    episode_id := (citation ->> 'episode')::uuid;
    IF episode_id = ANY(seen) THEN
      RETURN unavailable || jsonb_build_object('reason', 'duplicate_citation_identity');
    END IF;
    seen := array_append(seen, episode_id);
    SELECT * INTO e FROM app.episodes x WHERE x.workspace_id = ws AND x.id = episode_id;
    IF NOT FOUND THEN
      RETURN unavailable || jsonb_build_object('reason', 'missing_citation_episode');
    END IF;
    IF e.source_kind IS DISTINCT FROM 'message' OR e.run_id IS NOT NULL
       OR e.authored_by IS NULL OR e.authored_by = c.proposed_by
       OR e.recorded_by IS DISTINCT FROM system_id OR e.trust IS DISTINCT FROM 'trusted'
       OR e.task_id IS NULL OR e.document_id IS NOT NULL OR e.document_version IS NOT NULL
       OR e.connection_id IS NOT NULL THEN
      RETURN unavailable || jsonb_build_object('reason', 'not_a_standalone_person_message_source');
    END IF;
    IF e.source_ref !~ '^message:[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
      RETURN unavailable || jsonb_build_object('reason', 'missing_native_message_reference');
    END IF;
    -- The reference is only a lookup hint. Authority comes from the native message,
    -- author/role/content/task match and its independent immutable posting event.
    message_id := substring(e.source_ref FROM 9)::uuid;
    SELECT * INTO m FROM app.messages x WHERE x.workspace_id = ws AND x.id = message_id;
    IF NOT FOUND THEN
      RETURN unavailable || jsonb_build_object('reason', 'missing_native_message');
    END IF;
    IF m.role IS DISTINCT FROM 'person' OR m.run_id IS NOT NULL OR m.only_for IS NOT NULL
       OR m.author_id IS DISTINCT FROM e.authored_by OR m.task_id IS DISTINCT FROM e.task_id
       OR m.content IS DISTINCT FROM e.content OR NOT EXISTS (
         SELECT FROM app.principals p WHERE p.workspace_id = ws AND p.id = m.author_id AND p.kind = 'person'
       ) THEN
      RETURN unavailable || jsonb_build_object('reason', 'native_message_row_mismatch');
    END IF;
    excerpt := citation ->> 'excerpt';
    content_sha256 := encode(sha256(convert_to(e.content, 'UTF8')), 'hex');
    IF e.content_hash IS DISTINCT FROM content_sha256 OR length(excerpt) = 0
       OR position(excerpt IN e.content) = 0 THEN
      RETURN unavailable || jsonb_build_object('reason', 'citation_content_mismatch');
    END IF;

    SELECT count(*) INTO matches FROM app.ledger l
    WHERE l.workspace_id = ws AND l.entry_type = 'message.posted' AND l.subject = m.id::text;
    IF matches <> 1 THEN
      RETURN unavailable || jsonb_build_object('reason', 'ambiguous_message_posting_cut');
    END IF;
    SELECT * INTO posting FROM app.ledger l
    WHERE l.workspace_id = ws AND l.entry_type = 'message.posted' AND l.subject = m.id::text;
    IF posting.actor_id IS DISTINCT FROM m.author_id
       OR posting.payload IS DISTINCT FROM jsonb_build_object('task', m.task_id, 'role', 'person') THEN
      RETURN unavailable || jsonb_build_object('reason', 'message_posting_row_mismatch');
    END IF;
    IF posting.hash IS DISTINCT FROM sec.ledger_hash(posting.prev_hash, posting.workspace_id,
         posting.seq, posting.entry_type, posting.actor_id, posting.subject, posting.payload, posting.at)
       OR NOT EXISTS (
         SELECT FROM app.ledger previous WHERE previous.workspace_id = ws
           AND previous.seq = posting.seq - 1 AND previous.hash = posting.prev_hash
       ) THEN
      RETURN unavailable || jsonb_build_object('reason', 'message_posting_chain_mismatch');
    END IF;

    SELECT count(*) INTO matches FROM app.ledger l
    WHERE l.workspace_id = ws AND l.entry_type = 'source.recorded' AND l.subject = e.id::text;
    IF matches <> 1 THEN
      RETURN unavailable || jsonb_build_object('reason', 'ambiguous_source_cut');
    END IF;
    SELECT * INTO recording FROM app.ledger l
    WHERE l.workspace_id = ws AND l.entry_type = 'source.recorded' AND l.subject = e.id::text;
    ref_digest := sec.digest(e.source_ref);
    content_digest := sec.digest(e.content);
    IF ref_digest IS NULL OR ref_digest !~ '^[a-f0-9]{64}$'
       OR content_digest IS NULL OR content_digest !~ '^[a-f0-9]{64}$'
       OR recording.actor_id IS DISTINCT FROM system_id
       OR recording.payload IS DISTINCT FROM jsonb_build_object(
         'kind', 'message', 'trust', 'trusted', 'run', NULL, 'task', e.task_id,
         'ref', ref_digest, 'content', content_digest)
       OR NOT (posting.seq < recording.seq AND recording.seq <= p_capture_seq) THEN
      RETURN unavailable || jsonb_build_object('reason', 'source_recording_row_or_order_mismatch');
    END IF;
    IF recording.hash IS DISTINCT FROM sec.ledger_hash(recording.prev_hash, recording.workspace_id,
         recording.seq, recording.entry_type, recording.actor_id, recording.subject, recording.payload, recording.at)
       OR NOT EXISTS (
         SELECT FROM app.ledger previous WHERE previous.workspace_id = ws
           AND previous.seq = recording.seq - 1 AND previous.hash = recording.prev_hash
       ) THEN
      RETURN unavailable || jsonb_build_object('reason', 'source_recording_chain_mismatch');
    END IF;

    SELECT * INTO task FROM app.tasks x WHERE x.workspace_id = ws AND x.id = e.task_id;
    IF NOT FOUND OR NOT sec.task_visible_to(e.task_id, p_receiving_person) THEN
      RETURN unavailable || jsonb_build_object('reason', 'receiving_audience_unavailable');
    END IF;
    roots := roots || jsonb_build_array(jsonb_build_object(
      'episode_id', e.id, 'message_id', m.id, 'author_id', m.author_id, 'task_id', m.task_id,
      'message_seq', posting.seq::text, 'source_seq', recording.seq::text,
      'source_kind', 'message', 'content_sha256', content_sha256,
      'excerpt_sha256', encode(sha256(convert_to(excerpt, 'UTF8')), 'hex'),
      'recorded_sensitive', e.sensitive
    ));
  END LOOP;

  -- One shared keyed encoder binds this result to the sibling immutable candidate proof.
  -- Its complete definition depends only on the existing candidate row and workspace key,
  -- not the unfinished proof table or BEFORE guard. Install it before this helper.
  claim_digest := gov._candidate_claim_digest_v1(c);
  IF claim_digest IS NULL OR claim_digest !~ '^[a-f0-9]{64}$' THEN
    RETURN unavailable || jsonb_build_object('reason', 'candidate_claim_digest_unavailable');
  END IF;
  RETURN jsonb_build_object(
    'format', 'personal-message-inputs-v1', 'state', 'known_personal_inputs',
    'trust_boundary', 'explicit_native_personal_declaration',
    'workspace_id', ws, 'candidate_id', c.id, 'proposed_by', c.proposed_by,
    'capture_seq', p_capture_seq::text,
    'claim_digest', claim_digest,
    'roots', (SELECT jsonb_agg(r.value ORDER BY (r.value ->> 'episode_id') COLLATE "C")
      FROM jsonb_array_elements(roots) r(value))
  );
END
$$;
ALTER FUNCTION gov._personal_message_inputs_v1(app.knowledge_candidates,uuid,bigint) OWNER TO backbone_gov;
REVOKE ALL ON FUNCTION gov._personal_message_inputs_v1(app.knowledge_candidates,uuid,bigint) FROM PUBLIC, backbone_app, backbone_operator;
-- The owner executes it internally; there is no direct app/operator or caller completeness grant.
