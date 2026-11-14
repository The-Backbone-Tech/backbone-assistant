-- Material closure hardening v1. Preserves the released proposal shapes; lineage stays conservative.
CREATE OR REPLACE FUNCTION sec.t_candidate_input_capture_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  old_person text:=coalesce(current_setting('backbone.principal',true),''); old_run text:=coalesce(current_setting('backbone.run',true),''); old_secret text:=coalesce(current_setting('backbone.secret',true),'');
  ws uuid;
  actor uuid;
  native_run uuid;
  beneficiary uuid;
  r app.runs%ROWTYPE;
  e app.episodes%ROWTYPE;
  source_run_task uuid;
  connection app.connections%ROWTYPE;
  boundary app.ledger%ROWTYPE;
  captured app.ledger%ROWTYPE;
  head app.ledger_heads%ROWTYPE;
  citation jsonb;
  matches bigint;
  cited_untrusted boolean := false;
  manifest jsonb;
  claim_digest text;
  reserved boolean;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_TABLE_SCHEMA <> 'app' OR TG_TABLE_NAME <> 'knowledge_candidates' THEN
    RAISE EXCEPTION 'invalid: candidate input capture belongs only to candidate insertion';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'paused: candidate input capture requires READ COMMITTED isolation';
  END IF;
  -- No actor/run/source read before the waiting statement. All authority is rederived later.
  PERFORM gov._lock_workspace();
  ws := sec.current_workspace();
  IF ws IS NULL OR NEW.workspace_id IS DISTINCT FROM ws THEN
    RAISE EXCEPTION 'no_identity: candidate capture requires its native workspace';
  END IF;
  actor := sec.current_principal();
  native_run := sec.current_run();
  IF actor IS NULL OR (sec.names_run() AND native_run IS NULL)
     OR NEW.proposed_by IS DISTINCT FROM actor OR NEW.run_id IS DISTINCT FROM native_run THEN
    RAISE EXCEPTION 'stale: candidate identity no longer matches the authenticated native actor and run';
  END IF;
  IF NEW.id IS NULL OR EXISTS (SELECT FROM app.knowledge_candidates c WHERE c.workspace_id=ws AND c.id=NEW.id)
     OR EXISTS (SELECT FROM app.knowledge_candidate_inputs p WHERE p.workspace_id=ws AND p.candidate_id=NEW.id)
     OR EXISTS (SELECT FROM app.ledger l WHERE l.workspace_id=ws AND l.entry_type='knowledge.proposed' AND l.subject=NEW.id::text) THEN
    RAISE EXCEPTION 'conflict: candidate capture requires a new candidate, proof and proposal identity';
  END IF;
  IF NEW.status IS DISTINCT FROM 'open' OR NEW.owner_id IS NOT NULL OR NEW.valid_from IS NOT NULL
     OR NEW.valid_to IS NOT NULL OR NEW.terms_hash IS NOT NULL THEN
    RAISE EXCEPTION 'invalid: candidate creation grants no acceptance or terms';
  END IF;
  IF NEW.statement IS NULL OR length(NEW.statement) NOT BETWEEN 1 AND 4000 OR NEW.topic IS NULL
     OR NEW.created_at IS NULL OR jsonb_typeof(NEW.evidence) IS DISTINCT FROM 'array'
     OR jsonb_array_length(NEW.evidence)=0 THEN
    RAISE EXCEPTION 'invalid: a candidate states a claim and cites recorded sources';
  END IF;
  IF native_run IS NOT NULL THEN
    BEGIN
      -- Older native recorders may own run before head. Never wait in the reverse order.
      SELECT x.* INTO r FROM app.runs x WHERE x.workspace_id=ws AND x.id=native_run FOR UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'paused: candidate run is changing; retry after its native owner settles';
    END;
    IF NOT FOUND THEN RAISE EXCEPTION 'stale: candidate run no longer exists'; END IF;
    r := gov._holder(native_run,r.fence);
    IF gov.run_standing(native_run) IS DISTINCT FROM 'ok' OR r.status IS DISTINCT FROM 'running'
       OR r.agent_id IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'stale: candidate run no longer has native standing';
    END IF;
    beneficiary := gov._run_person(native_run);
    IF beneficiary IS NULL OR NOT EXISTS (SELECT FROM app.principals p WHERE p.workspace_id=ws
         AND p.id=beneficiary AND p.kind='person' AND p.status='active')
       OR NOT sec.task_visible_to(r.task_id,beneficiary) THEN
      RAISE EXCEPTION 'denied: candidate run has no current authorised native beneficiary';
    END IF;
  ELSE
    -- A standalone agent stays an agent; its owner is an audience, not a personal declaration.
    beneficiary := sec.acting_for();
    IF beneficiary IS NOT NULL AND NOT EXISTS (SELECT FROM app.principals p WHERE p.workspace_id=ws
         AND p.id=beneficiary AND p.kind='person' AND p.status='active') THEN
      RAISE EXCEPTION 'denied: candidate has no active native receiving person';
    END IF;
  END IF;
  NEW.created_at := clock_timestamp();
  NEW.proposed_by := actor;
  NEW.run_id := native_run;
  NEW.on_behalf_of := beneficiary;

  SELECT count(*) INTO matches FROM app.ledger l WHERE l.workspace_id=ws
    AND l.entry_type='knowledge.dependencies_enabled';
  IF matches<>1 THEN RAISE EXCEPTION 'paused: candidate needs one native dependency boundary'; END IF;
  SELECT l.* INTO boundary FROM app.ledger l WHERE l.workspace_id=ws
    AND l.entry_type='knowledge.dependencies_enabled';
  SELECT h.* INTO head FROM app.ledger_heads h WHERE h.workspace_id=ws;
  SELECT l.* INTO captured FROM app.ledger l WHERE l.workspace_id=ws AND l.seq=head.last_seq;
  IF NOT FOUND OR boundary.subject IS NOT NULL
     OR boundary.payload IS DISTINCT FROM jsonb_build_object('version','material-closure-foundation-v1')
     OR boundary.seq>captured.seq OR captured.seq>=9223372036854775807
     OR head.last_hash IS DISTINCT FROM captured.hash
     OR boundary.hash IS DISTINCT FROM sec.ledger_hash(boundary.prev_hash,boundary.workspace_id,boundary.seq,
       boundary.entry_type,boundary.actor_id,boundary.subject,boundary.payload,boundary.at)
     OR captured.hash IS DISTINCT FROM sec.ledger_hash(captured.prev_hash,captured.workspace_id,captured.seq,
       captured.entry_type,captured.actor_id,captured.subject,captured.payload,captured.at) THEN
    RAISE EXCEPTION 'paused: candidate boundary or captured native head is inconsistent';
  END IF;

  PERFORM set_config('backbone.run','',true); PERFORM set_config('backbone.secret','',true); PERFORM set_config('backbone.principal',sec.system_principal()::text,true);
  FOR citation IN SELECT value FROM jsonb_array_elements(NEW.evidence) LOOP
    -- Match the released source lookup exactly. Unsupported citation shapes are captured
    -- as incomplete by the manifest; no promotion-time evidence rule is moved here.
    SELECT x.* INTO e FROM app.episodes x WHERE x.workspace_id=ws AND x.id::text=citation ->> 'episode';
    -- Proposal captures inputs; the released promotion crossing checks literal evidence.
    -- A mismatch is retained in the immutable manifest and cannot certify personal lineage.
    IF NOT FOUND OR e.content_hash IS DISTINCT FROM encode(sha256(convert_to(e.content,'UTF8')),'hex') THEN
      RAISE EXCEPTION 'invalid: candidate source is missing or its recorded content hash is inconsistent';
    END IF;
    cited_untrusted := cited_untrusted OR e.trust='untrusted';
    -- Never use System-recorder visibility or same-run identity as an audience exemption.
    IF e.task_id IS NOT NULL AND NOT (
         (beneficiary IS NOT NULL AND sec.task_visible_to(e.task_id,beneficiary))
         OR (beneficiary IS NULL AND EXISTS (SELECT FROM app.tasks t WHERE t.workspace_id=ws
           AND t.id=e.task_id AND t.visibility='workspace'))) THEN
      RAISE EXCEPTION 'denied: candidate citation is outside its receiving audience';
    END IF;
    IF e.run_id IS NOT NULL THEN
      SELECT x.task_id INTO source_run_task FROM app.runs x WHERE x.workspace_id=ws AND x.id=e.run_id;
      IF NOT FOUND OR NOT ((beneficiary IS NOT NULL AND sec.task_visible_to(source_run_task,beneficiary))
          OR (beneficiary IS NULL AND EXISTS (SELECT FROM app.tasks t WHERE t.workspace_id=ws
            AND t.id=source_run_task AND t.visibility='workspace'))) THEN
        RAISE EXCEPTION 'denied: candidate source run is outside its receiving audience';
      END IF;
    END IF;
    IF e.connection_id IS NOT NULL THEN
      SELECT x.* INTO connection FROM app.connections x WHERE x.workspace_id=ws AND x.id=e.connection_id;
      IF NOT FOUND OR (connection.scope='person' AND connection.owner_id IS DISTINCT FROM beneficiary) THEN
        RAISE EXCEPTION 'denied: candidate connected source belongs to another audience';
      END IF;
    END IF;
    IF e.source_kind='message' AND e.source_ref ~ '^message:[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
       AND EXISTS (SELECT FROM app.messages m WHERE m.workspace_id=ws
         AND m.id=substring(e.source_ref FROM 9)::uuid AND m.only_for IS NOT NULL
         AND m.only_for IS DISTINCT FROM beneficiary) THEN
      RAISE EXCEPTION 'denied: candidate message is kept for another person';
    END IF;
    reserved := e.source_kind='mcp' OR (e.source_kind='file' AND left(e.source_ref,9) COLLATE "C"='material:');
    IF reserved AND gov._material_source_projection(e.id) IS DISTINCT FROM 'live' THEN
      RAISE EXCEPTION 'paused: cited material is withdrawn or its native binding is unknown';
    END IF;
  END LOOP;
  -- Preserve the released candidate semantics, now from post-lock native facts.
  -- Incomplete lineage is represented independently; false taint is never a clean proof.
  NEW.words_untrusted := cited_untrusted OR CASE WHEN native_run IS NULL THEN false ELSE r.tainted_untrusted END;
  NEW.kept := CASE WHEN native_run IS NULL THEN false ELSE r.tainted_untrusted AND r.tainted_sensitive END;
  claim_digest := gov._candidate_claim_digest_v1(NEW::app.knowledge_candidates);
  IF claim_digest IS NULL OR claim_digest !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'paused: candidate claim digest is unavailable';
  END IF;
  manifest := gov._candidate_input_manifest_v1(NEW::app.knowledge_candidates,captured.seq);
  IF EXISTS (SELECT FROM jsonb_array_elements(manifest -> 'unknown') u
      WHERE u ->> 'kind' IN ('source_history_not_demonstrated','material_registration_history_not_demonstrated')
        AND EXISTS (SELECT FROM jsonb_array_elements(NEW.evidence) c WHERE c ->> 'episode'=u ->> 'episode_id')
        AND EXISTS (SELECT FROM app.episodes x WHERE x.workspace_id=ws AND x.id::text=u ->> 'episode_id'
          AND (x.source_kind='mcp' OR (x.source_kind='file' AND left(x.source_ref,9) COLLATE "C"='material:')))) THEN
    RAISE EXCEPTION 'paused: cited material has no unambiguous native read history';
  END IF;
  -- Always fresh INSERT, no conflict recovery, no reuse, no backfill. Same-statement
  -- failure rolls back this proof; deferred candidate FK permits the BEFORE ordering.
  INSERT INTO app.knowledge_candidate_inputs(workspace_id,candidate_id,format_version,
    boundary_seq,boundary_hash,capture_seq,capture_hash,proposed_by,run_id,run_fence,run_task_id,
    on_behalf_of,run_tainted_untrusted,run_tainted_sensitive,words_untrusted,kept,
    claim_digest,input_manifest,input_sha256)
  VALUES(ws,NEW.id,1,boundary.seq,boundary.hash,captured.seq,captured.hash,actor,native_run,
    CASE WHEN native_run IS NULL THEN NULL ELSE r.fence END,
    CASE WHEN native_run IS NULL THEN NULL ELSE r.task_id END,beneficiary,
    CASE WHEN native_run IS NULL THEN NULL ELSE r.tainted_untrusted END,
    CASE WHEN native_run IS NULL THEN NULL ELSE r.tainted_sensitive END,NEW.words_untrusted,NEW.kept,
    claim_digest,manifest,encode(sha256(convert_to(manifest::text,'UTF8')),'hex'));
  -- No _append here: the old body must append knowledge.proposed immediately at H+1.
  PERFORM set_config('backbone.principal',old_person,true); PERFORM set_config('backbone.run',old_run,true); PERFORM set_config('backbone.secret',old_secret,true);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('backbone.principal',old_person,true); PERFORM set_config('backbone.run',old_run,true); PERFORM set_config('backbone.secret',old_secret,true);
  RAISE;
END
$$;
ALTER FUNCTION sec.t_candidate_input_capture_v1() OWNER TO backbone_gov;
REVOKE ALL ON FUNCTION sec.t_candidate_input_capture_v1() FROM PUBLIC, backbone_app, backbone_operator;
GRANT EXECUTE ON FUNCTION sec.t_candidate_input_capture_v1() TO backbone_owner;
