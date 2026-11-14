-- Material closure foundation v1. Canonical versioned source; see its closed manifest.
CREATE FUNCTION gov.recall_knowledge_traced_v1(
  p_run uuid, p_fence bigint, p_words text[], p_limit integer
) RETURNS TABLE(read_id uuid, knowledge_id uuid, candidate_id uuid, read_seq bigint, statement text, topic text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid;
  r app.runs%ROWTYPE;
  person uuid;
  k app.knowledge%ROWTYPE;
  c app.knowledge_candidates%ROWTYPE;
  accepted app.ledger%ROWTYPE;
  closure jsonb;
  snapshot jsonb;
  ids uuid[] := ARRAY[]::uuid[];
  knowledge_ids uuid[] := ARRAY[]::uuid[];
  candidate_ids uuid[] := ARRAY[]::uuid[];
  snapshots jsonb[] := ARRAY[]::jsonb[];
  hashes text[] := ARRAY[]::text[];
  statements text[] := ARRAY[]::text[];
  topics text[] := ARRAY[]::text[];
  sensitivities boolean[] := ARRAY[]::boolean[];
  elsewheres boolean[] := ARRAY[]::boolean[];
  batch uuid := gen_random_uuid();
  batch_seq bigint;
  batch_payload jsonb := '[]'::jsonb;
  sensitive boolean;
  elsewhere boolean;
  seen integer := 0;
  root_count integer := 0;
  snapshot_bytes integer := 0;
  result_bytes bigint := 0;
  input_bytes bigint := 0;
  proof_bytes bigint;
  roots_examined bigint := 0;
  n integer := 0;
  i integer;
  matches bigint;
  admitted_at timestamptz;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'paused: traced knowledge recall requires READ COMMITTED isolation';
  END IF;
  -- Request bounds are operational refusal, never a truncated closure or completeness flag.
  IF p_run IS NULL OR p_fence IS NULL OR p_fence <= 0
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid: traced recall requires a run, positive fence and limit between 1 and 100';
  END IF;
  IF coalesce(cardinality(p_words),0) > 64
     OR EXISTS (SELECT FROM unnest(p_words) w WHERE length(w)>256)
     OR (SELECT coalesce(sum(length(w)),0) FROM unnest(p_words) w)>8192 THEN
    RAISE EXCEPTION 'invalid: traced recall search exceeds its bounded request budget';
  END IF;
  -- Deliberately its OWN VOLATILE statement, before every current authority projection.
  PERFORM gov._lock_workspace();
  BEGIN
    SELECT x.* INTO r FROM app.runs x WHERE x.workspace_id=sec.current_workspace()
      AND x.id=p_run FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'paused: the receiving run is changing; retry after its native owner settles';
  END;
  r := gov._holder(p_run,p_fence);
  IF gov.run_standing(p_run) IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'paused: the receiving run no longer stands';
  END IF;
  ws := sec.current_workspace();
  person := gov._run_person(p_run);
  IF sec.current_run() IS DISTINCT FROM p_run OR sec.current_principal() IS DISTINCT FROM r.agent_id
     OR person IS NULL OR NOT EXISTS (SELECT FROM app.principals p
       WHERE p.workspace_id=ws AND p.id=person AND p.kind='person' AND p.status='active')
     OR NOT sec.task_visible_to(r.task_id,person) THEN
    RAISE EXCEPTION 'paused: the receiving run has no current native beneficiary audience';
  END IF;
  -- Do NOT lock knowledge/candidate rows here. retract_knowledge locks knowledge before head;
  -- adding an inverse row lock would deadlock. These post-head MVCC reads see committed state;
  -- a retraction waiting on our head linearizes after this recall.
  FOR k IN SELECT x.* FROM app.knowledge x
    WHERE x.workspace_id=ws AND x.status='accepted'
    ORDER BY x.created_at,x.id LIMIT 5001
  LOOP
    seen := seen+1;
    IF seen>5000 THEN
      RAISE EXCEPTION 'paused: traced recall candidate scan exceeds its bounded budget';
    END IF;
    IF (k.valid_from IS NOT NULL AND k.valid_from>clock_timestamp())
       OR (k.valid_to IS NOT NULL AND k.valid_to<=clock_timestamp())
       OR (coalesce(cardinality(p_words),0)>0 AND NOT EXISTS (
         SELECT FROM unnest(p_words) w WHERE position(lower(w) IN lower(k.statement))>0)) THEN
      CONTINUE;
    END IF;
    SELECT * INTO c FROM app.knowledge_candidates x WHERE x.workspace_id=ws AND x.id=k.candidate_id;
    -- Charge every candidate/input that will reach a helper, including UNKNOWN results.
    -- No proof bytes or arbitrarily long citation arrays can hide behind output p_limit.
    IF FOUND THEN
      roots_examined := roots_examined+CASE WHEN jsonb_typeof(c.evidence)='array'
        THEN jsonb_array_length(c.evidence) ELSE 1 END;
      SELECT coalesce(octet_length(p.input_manifest::text),0) INTO proof_bytes
        FROM app.knowledge_candidate_inputs p WHERE p.workspace_id=ws AND p.candidate_id=c.id;
      input_bytes := input_bytes+octet_length(c.evidence::text)+octet_length(c.statement)
        +octet_length(c.topic)+coalesce(proof_bytes,0);
      IF roots_examined>1024 OR input_bytes>2097152 THEN
        RAISE EXCEPTION 'paused: traced recall input derivation budget exceeded';
      END IF;
    END IF;
    IF c.id IS NULL OR c.status IS DISTINCT FROM 'accepted' OR c.run_id IS NOT NULL
       OR c.words_untrusted OR c.kept OR k.words_untrusted
       OR c.terms_hash IS NULL OR k.statement IS DISTINCT FROM c.statement
       OR k.topic IS DISTINCT FROM c.topic OR k.owner_id IS DISTINCT FROM c.owner_id
       OR k.valid_from IS DISTINCT FROM c.valid_from OR k.valid_to IS DISTINCT FROM c.valid_to THEN
      CONTINUE;
    END IF;
    closure := gov._knowledge_personal_closure_v1(c.id,person);
    IF closure ->> 'state' IS DISTINCT FROM 'known_personal_closure' THEN
      CONTINUE;
    END IF;
    SELECT count(*) INTO matches FROM app.ledger l WHERE l.workspace_id=ws
      AND l.entry_type='knowledge.accepted' AND l.subject=k.id::text;
    IF matches<>1 THEN CONTINUE; END IF;
    SELECT * INTO accepted FROM app.ledger l WHERE l.workspace_id=ws
      AND l.entry_type='knowledge.accepted' AND l.subject=k.id::text;
    IF accepted.actor_id IS DISTINCT FROM k.accepted_by
       OR accepted.payload IS DISTINCT FROM jsonb_build_object('candidate',c.id,'decision',k.decision_id,'owner',k.owner_id)
       OR accepted.seq<=(closure #>> '{roots,proposal_seq}')::bigint
       OR accepted.hash IS DISTINCT FROM sec.ledger_hash(accepted.prev_hash,ws,accepted.seq,
         accepted.entry_type,accepted.actor_id,accepted.subject,accepted.payload,accepted.at)
       OR NOT EXISTS (SELECT FROM app.ledger l WHERE l.workspace_id=ws
         AND l.seq=accepted.seq-1 AND l.hash=accepted.prev_hash) THEN
      CONTINUE;
    END IF;
    root_count := root_count+jsonb_array_length(closure #> '{roots,roots}');
    IF root_count>1024 THEN
      RAISE EXCEPTION 'paused: traced recall root snapshot exceeds its bounded write budget';
    END IF;
    SELECT coalesce(bool_or((root ->> 'currently_sensitive')::boolean),false),
      coalesce(bool_or((root ->> 'currently_sensitive')::boolean AND (root ->> 'task_id')::uuid<>r.task_id),false)
      INTO sensitive,elsewhere FROM jsonb_array_elements(closure #> '{roots,roots}') root;
    snapshot := jsonb_build_object('format','knowledge-personal-closure-v1',
      'knowledge_id',k.id,'candidate_id',c.id,'decision_id',k.decision_id,
      'owner_id',k.owner_id,'valid_from',to_char(k.valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'valid_to',to_char(k.valid_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'words_untrusted',k.words_untrusted,'accepted_by',k.accepted_by,
      'accepted_seq',accepted.seq::text,'accepted_hash',accepted.hash,'candidate_closure',closure);
    snapshot_bytes := snapshot_bytes+octet_length(snapshot::text);
    IF octet_length(snapshot::text)>131072 OR snapshot_bytes>2097152 THEN
      RAISE EXCEPTION 'paused: traced recall snapshot byte budget exceeded';
    END IF;
    -- Legacy topic has no byte bound. Charge all returned text plus the canonical native
    -- identity/cut fields before buffering; a large later row never yields a partial batch.
    result_bytes := result_bytes+octet_length(k.statement)+octet_length(k.topic)+128;
    IF result_bytes>2097152 THEN
      RAISE EXCEPTION 'paused: traced recall result byte budget exceeded';
    END IF;
    n := n+1;
    ids := array_append(ids,gen_random_uuid());
    knowledge_ids := array_append(knowledge_ids,k.id);
    candidate_ids := array_append(candidate_ids,c.id);
    snapshots := array_append(snapshots,snapshot);
    hashes := array_append(hashes,encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'));
    statements := array_append(statements,k.statement);
    topics := array_append(topics,k.topic);
    sensitivities := array_append(sensitivities,sensitive);
    elsewheres := array_append(elsewheres,elsewhere);
    batch_payload := batch_payload || jsonb_build_array(jsonb_build_object(
      'read',ids[n],'knowledge',k.id,'candidate',c.id,'source',hashes[n]));
    EXIT WHEN n=p_limit;
  END LOOP;
  -- Standing and validity are checked again after bounded projection work, before marking
  -- or appending. No additional lease-expiry condition is invented; _holder/run_standing own it.
  IF gov.run_standing(p_run) IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'paused: the receiving run stopped during traced recall';
  END IF;
  admitted_at := clock_timestamp();
  IF EXISTS (SELECT FROM app.knowledge x WHERE x.workspace_id=ws AND x.id=ANY(knowledge_ids)
    AND (x.status<>'accepted' OR (x.valid_from IS NOT NULL AND x.valid_from>admitted_at)
      OR (x.valid_to IS NOT NULL AND x.valid_to<=admitted_at))) THEN
    RAISE EXCEPTION 'paused: accepted knowledge changed or expired during traced recall';
  END IF;
  PERFORM gov._mark(p_run,NULL,
    CASE WHEN true=ANY(sensitivities) THEN 'traced knowledge batch '||batch::text END,
    CASE WHEN true=ANY(elsewheres) THEN 'traced knowledge batch '||batch::text END);
  batch_seq := gov._append('knowledge.recalled',batch::text,
    jsonb_build_object('version',1,'run',p_run,'fence',p_fence,'reads',batch_payload),r.agent_id);
  -- A successful empty call records its invocation but certifies NO context completeness.
  -- The only insertion loop precedes the ONLY result handover. Any failed insert raises and
  -- rolls back marks, event, head and every row atomically; no catch/partial-success handler.
  FOR i IN 1..n LOOP
    INSERT INTO app.knowledge_reads(workspace_id,read_id,batch_id,batch_ordinal,read_seq,
      receiving_run_id,receiving_fence,receiving_agent_id,receiving_person_id,receiving_task_id,
      knowledge_id,candidate_id,source_snapshot,source_sha256,source_sensitive,source_elsewhere,read_at)
    VALUES(ws,ids[i],batch,i,batch_seq,p_run,p_fence,r.agent_id,person,r.task_id,
      knowledge_ids[i],candidate_ids[i],snapshots[i],hashes[i],sensitivities[i],elsewheres[i],admitted_at);
  END LOOP;
  RETURN QUERY SELECT ids[j],knowledge_ids[j],candidate_ids[j],batch_seq,statements[j],topics[j]
    FROM generate_subscripts(ids,1) j ORDER BY j;
  -- The client MUST hold these results privately until COMMIT returns command tag COMMIT.
END
$$;
ALTER FUNCTION gov.recall_knowledge_traced_v1(uuid,bigint,text[],integer) OWNER TO backbone_gov;
REVOKE ALL ON FUNCTION gov.recall_knowledge_traced_v1(uuid,bigint,text[],integer)
  FROM PUBLIC,backbone_app,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.recall_knowledge_traced_v1(uuid,bigint,text[],integer) TO backbone_app;
