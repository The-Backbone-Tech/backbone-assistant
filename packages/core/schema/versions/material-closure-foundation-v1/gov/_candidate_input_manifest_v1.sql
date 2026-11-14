-- Material closure foundation v1. Canonical versioned source; see its closed manifest.
CREATE FUNCTION gov._candidate_input_manifest_v1(p_claim app.knowledge_candidates, p_capture_seq bigint)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  personal jsonb;
  sources jsonb := '[]'::jsonb;
  edges jsonb := '[]'::jsonb;
  unknowns jsonb := '[]'::jsonb;
  e app.episodes%ROWTYPE;
  receipt app.material_source_reads%ROWTYPE;
  l app.ledger%ROWTYPE;
  k app.knowledge_reads%ROWTYPE;
  native_run app.runs%ROWTYPE;
  recordings jsonb;
  registrations jsonb;
  citations jsonb;
  n bigint;
  material_state text;
  reserved boolean;
BEGIN
  IF ws IS NULL OR (p_claim).workspace_id IS DISTINCT FROM ws OR p_capture_seq IS NULL OR p_capture_seq < 1 THEN
    RAISE EXCEPTION 'paused: input snapshot requires native workspace and ledger cut';
  END IF;
  personal := gov._personal_message_inputs_v1(p_claim, (p_claim).proposed_by, p_capture_seq);
  IF personal ->> 'state' = 'known_personal_inputs' THEN
    RETURN jsonb_build_object('version', 1, 'complete', true, 'sources', personal -> 'roots',
      'read_edges', '[]'::jsonb, 'unknown', '[]'::jsonb);
  END IF;
  unknowns := unknowns || jsonb_build_array(jsonb_build_object(
    'kind', CASE WHEN (p_claim).run_id IS NULL THEN 'unsupported_standalone_declaration'
      ELSE 'untraced_native_producers' END,
    'personal_family_reason', personal ->> 'reason', 'run_id', (p_claim).run_id));

  -- No caller-supplied subset: every extant episode assigned to the native run plus
  -- every citation, even when its historical recording is absent/ambiguous, is retained.
  FOR e IN SELECT x.* FROM app.episodes x WHERE x.workspace_id = ws AND (
    ((p_claim).run_id IS NOT NULL AND x.run_id = (p_claim).run_id
      AND NOT ((SELECT count(*) FROM app.ledger cut WHERE cut.workspace_id=ws
        AND cut.entry_type='source.recorded' AND cut.subject=x.id::text)=1
        AND EXISTS (SELECT FROM app.ledger cut WHERE cut.workspace_id=ws
          AND cut.entry_type='source.recorded' AND cut.subject=x.id::text AND cut.seq>p_capture_seq)))
    OR EXISTS (SELECT FROM jsonb_array_elements((p_claim).evidence) c
      WHERE c ->> 'episode' = x.id::text)) ORDER BY x.id LOOP
    SELECT coalesce(jsonb_agg(jsonb_build_object('ordinal', c.ordinality::text,
      'excerpt_sha256', encode(sha256(convert_to(c.value ->> 'excerpt', 'UTF8')), 'hex'),
      'verbatim', length(c.value ->> 'excerpt') > 0 AND position((c.value ->> 'excerpt') IN e.content) > 0)
      ORDER BY c.ordinality), '[]'::jsonb) INTO citations
    FROM jsonb_array_elements((p_claim).evidence) WITH ORDINALITY c(value, ordinality)
    WHERE c.value ->> 'episode' = e.id::text;
    IF EXISTS (SELECT FROM jsonb_array_elements(citations) c WHERE c ->> 'verbatim' IS DISTINCT FROM 'true') THEN
      unknowns := unknowns || jsonb_build_array(jsonb_build_object('kind','citation_not_verbatim','episode_id',e.id));
    END IF;
    SELECT count(*), coalesce(jsonb_agg(jsonb_build_object(
      'seq', x.seq::text, 'actor_id', x.actor_id, 'payload', x.payload,
      'prev_hash', x.prev_hash, 'hash', x.hash) ORDER BY x.seq), '[]'::jsonb)
    INTO n, recordings FROM app.ledger x WHERE x.workspace_id = ws
      AND x.entry_type = 'source.recorded' AND x.subject = e.id::text AND x.seq <= p_capture_seq;
    IF n <> 1 OR e.content_hash IS DISTINCT FROM encode(sha256(convert_to(e.content, 'UTF8')), 'hex')
       OR EXISTS (SELECT FROM app.ledger x WHERE x.workspace_id = ws AND x.entry_type = 'source.recorded'
         AND x.subject = e.id::text AND (x.seq > p_capture_seq
          OR x.actor_id IS DISTINCT FROM sec.system_principal()
          OR x.payload IS DISTINCT FROM (CASE
            WHEN e.source_kind IN ('file','sandbox','message','web') THEN jsonb_build_object(
              'kind',e.source_kind,'trust',e.trust,'run',e.run_id,'task',e.task_id,
              'ref',sec.digest(e.source_ref),'content',sec.digest(e.content))
            WHEN e.source_kind='document' THEN jsonb_build_object('kind','document','run',e.run_id,
              'document',e.document_id,'version',e.document_version)
            WHEN e.source_kind='mcp' THEN jsonb_build_object('kind','mcp','run',e.run_id,
              'connection',e.connection_id,'tool',sec.digest(substring(e.source_ref FROM 42)))
            ELSE NULL::jsonb END)
          OR x.hash IS DISTINCT FROM sec.ledger_hash(x.prev_hash,x.workspace_id,x.seq,x.entry_type,x.actor_id,x.subject,x.payload,x.at)
          OR NOT EXISTS (SELECT FROM app.ledger prev WHERE prev.workspace_id=ws
            AND prev.seq=x.seq-1 AND prev.hash=x.prev_hash))) THEN
      unknowns := unknowns || jsonb_build_array(jsonb_build_object('kind','source_history_not_demonstrated','episode_id',e.id));
    END IF;
    IF e.task_id IS NOT NULL AND NOT (
      ((p_claim).on_behalf_of IS NOT NULL AND sec.task_visible_to(e.task_id,(p_claim).on_behalf_of))
      OR ((p_claim).on_behalf_of IS NULL AND EXISTS (SELECT FROM app.tasks t WHERE t.workspace_id=ws
        AND t.id=e.task_id AND t.visibility='workspace'))) THEN
      unknowns := unknowns || jsonb_build_array(jsonb_build_object('kind','source_audience_unavailable_at_capture','episode_id',e.id));
    END IF;
    IF e.connection_id IS NOT NULL AND NOT EXISTS (SELECT FROM app.connections c WHERE c.workspace_id=ws
        AND c.id=e.connection_id AND (c.scope='workspace' OR c.owner_id=(p_claim).on_behalf_of)) THEN
      unknowns := unknowns || jsonb_build_array(jsonb_build_object('kind','connection_audience_unavailable_at_capture','episode_id',e.id));
    END IF;
    reserved := e.source_kind = 'mcp' OR (e.source_kind = 'file' AND left(e.source_ref,9) COLLATE "C" = 'material:');
    receipt := NULL;
    registrations := '[]'::jsonb;
    material_state := NULL;
    IF reserved THEN
      material_state := gov._material_source_projection(e.id);
      SELECT r.* INTO receipt FROM app.material_source_reads r WHERE r.workspace_id=ws AND r.episode_id=e.id;
      IF receipt.receipt_id IS NOT NULL THEN
        SELECT count(*), coalesce(jsonb_agg(jsonb_build_object('seq',x.seq::text,'actor_id',x.actor_id,
          'payload',x.payload,'prev_hash',x.prev_hash,'hash',x.hash) ORDER BY x.seq), '[]'::jsonb)
        INTO n, registrations FROM app.ledger x WHERE x.workspace_id=ws
          AND x.entry_type='material.read_registered' AND x.subject=receipt.receipt_id::text AND x.seq<=p_capture_seq;
        IF n <> 1 OR EXISTS (SELECT FROM app.ledger x WHERE x.workspace_id=ws
            AND x.entry_type='material.read_registered' AND x.subject=receipt.receipt_id::text
            AND (x.seq>p_capture_seq OR x.actor_id IS DISTINCT FROM receipt.recorded_by
              OR x.payload IS DISTINCT FROM jsonb_build_object('episode',e.id,'read_key',sec.digest(receipt.read_key),
                'project',sec.digest(receipt.project_id),'material',sec.digest(receipt.material_id),
                'version',receipt.material_version,'generation',receipt.generation,'kind',receipt.source_kind,
                'original_sha256',sec.digest(receipt.original_sha256),'transformation',sec.digest(receipt.transformation::text),
                'episode_sha256',sec.digest(receipt.episode_sha256),'prepared_sha256',sec.digest(receipt.prepared_sha256))
              OR x.hash IS DISTINCT FROM sec.ledger_hash(x.prev_hash,x.workspace_id,x.seq,x.entry_type,x.actor_id,x.subject,x.payload,x.at)
              OR NOT EXISTS (SELECT FROM app.ledger prev WHERE prev.workspace_id=ws AND prev.seq=x.seq-1 AND prev.hash=x.prev_hash))) THEN
          unknowns := unknowns || jsonb_build_array(jsonb_build_object('kind','material_registration_history_not_demonstrated','episode_id',e.id));
        END IF;
      END IF;
      IF material_state IS DISTINCT FROM 'live' THEN
        unknowns := unknowns || jsonb_build_array(jsonb_build_object('kind','material_not_live_at_capture',
          'episode_id',e.id,'state',material_state));
      END IF;
    END IF;
    sources := sources || jsonb_build_array(jsonb_build_object(
      'episode_id',e.id,'source_kind',e.source_kind,'source_ref_digest',sec.digest(e.source_ref),
      'trust',e.trust,'recorded_sensitive',e.sensitive,'recorded_by',e.recorded_by,'authored_by',e.authored_by,
      'run_id',e.run_id,'task_id',e.task_id,'document_id',e.document_id,'document_version',e.document_version,
      'connection_id',e.connection_id,'content_sha256',e.content_hash,'citations',citations,
      'recordings',recordings,'material_state_at_capture',material_state,
      'material_receipt', CASE WHEN receipt.receipt_id IS NULL THEN NULL::jsonb ELSE
        -- Full native receipt identities/hashes; omit caller-controlled transformation words/tool.
        jsonb_build_object('receipt_id',receipt.receipt_id,'read_key_digest',sec.digest(receipt.read_key),
          'material_id',receipt.material_id,'project_id',receipt.project_id,'version',receipt.material_version,
          'generation',receipt.generation,'original_sha256',receipt.original_sha256,
          'transformation_digest',sec.digest(receipt.transformation::text),'episode_sha256',receipt.episode_sha256,
          'prepared_sha256',receipt.prepared_sha256,'source_kind',receipt.source_kind,'authored_by',receipt.authored_by,
          'run_id',receipt.run_id,'requested_task_id',receipt.requested_task_id,'connection_id',receipt.connection_id,
          'tool_digest',sec.digest(receipt.tool),'recorded_by',receipt.recorded_by) END,
      'material_registrations',registrations));
  END LOOP;

  IF (p_claim).run_id IS NOT NULL THEN
    SELECT x.* INTO native_run FROM app.runs x WHERE x.workspace_id=ws AND x.id=(p_claim).run_id;
    edges := edges || jsonb_build_array(jsonb_build_object('kind','native_run_taint_observation',
      'run_id',native_run.id,'tainted_untrusted',native_run.tainted_untrusted,
      'tainted_sensitive',native_run.tainted_sensitive,'untrusted_reason_digest',sec.digest(native_run.untrusted_source),
      'sensitive_reason_digest',sec.digest(native_run.sensitive_source),'elsewhere_reason_digest',sec.digest(native_run.elsewhere_source)));
    -- Preserve every typed recall, including full inherited closure, never merely its taint.
    FOR k IN SELECT r.* FROM app.knowledge_reads r WHERE r.workspace_id=ws
      AND r.receiving_run_id=(p_claim).run_id AND r.read_seq<=p_capture_seq ORDER BY r.read_seq,r.batch_ordinal,r.read_id LOOP
      edges := edges || jsonb_build_array(jsonb_build_object('kind','native_knowledge_read','row',to_jsonb(k)));
      IF k.read_seq > p_capture_seq OR k.source_sha256 IS DISTINCT FROM
          encode(sha256(convert_to(k.source_snapshot::text,'UTF8')),'hex')
          OR NOT EXISTS (SELECT FROM app.ledger x WHERE x.workspace_id=ws AND x.seq=k.read_seq
            AND x.entry_type='knowledge.recalled' AND x.subject=k.batch_id::text
            AND x.actor_id=k.receiving_agent_id AND x.payload -> 'version' = '1'::jsonb
            AND x.payload ->> 'run'=k.receiving_run_id::text AND x.payload ->> 'fence'=k.receiving_fence::text
            AND x.payload -> 'reads' @> jsonb_build_array(jsonb_build_object('read',k.read_id,
              'knowledge',k.knowledge_id,'candidate',k.candidate_id,'source',k.source_sha256))
            AND x.hash=sec.ledger_hash(x.prev_hash,x.workspace_id,x.seq,x.entry_type,x.actor_id,x.subject,x.payload,x.at)
            AND EXISTS (SELECT FROM app.ledger prev WHERE prev.workspace_id=ws AND prev.seq=x.seq-1 AND prev.hash=x.prev_hash)) THEN
        unknowns := unknowns || jsonb_build_array(jsonb_build_object('kind','knowledge_read_history_not_demonstrated','read_id',k.read_id));
      END IF;
    END LOOP;
    -- Include original native event facts even when the corresponding episode/read is absent.
    -- These are observations, not a claim that every historically delivered output was traced.
    FOR l IN SELECT x.* FROM app.ledger x WHERE x.workspace_id=ws AND x.seq<=p_capture_seq
      AND x.entry_type IN ('source.recorded','knowledge.recalled')
      AND x.payload ->> 'run'=(p_claim).run_id::text ORDER BY x.seq LOOP
      edges := edges || jsonb_build_array(jsonb_build_object('kind','native_input_event','seq',l.seq::text,
        'entry_type',l.entry_type,'subject',l.subject,'actor_id',l.actor_id,
        'payload',l.payload,'prev_hash',l.prev_hash,'hash',l.hash));
      IF (l.entry_type='source.recorded' AND NOT EXISTS (SELECT FROM app.episodes x WHERE x.workspace_id=ws AND x.id::text=l.subject))
        OR (l.entry_type='knowledge.recalled' AND l.payload -> 'reads' IS DISTINCT FROM '[]'::jsonb AND NOT EXISTS (SELECT FROM app.knowledge_reads x WHERE x.workspace_id=ws AND x.batch_id::text=l.subject)) THEN
        unknowns := unknowns || jsonb_build_array(jsonb_build_object('kind','input_event_missing_native_row','seq',l.seq::text));
      END IF;
    END LOOP;
  END IF;
  RETURN jsonb_build_object('version',1,'complete',false,'sources',sources,'read_edges',edges,'unknown',unknowns);
END
$$;
ALTER FUNCTION gov._candidate_input_manifest_v1(app.knowledge_candidates,bigint) OWNER TO backbone_gov;
REVOKE ALL ON FUNCTION gov._candidate_input_manifest_v1(app.knowledge_candidates,bigint)
  FROM PUBLIC, backbone_app, backbone_operator;
