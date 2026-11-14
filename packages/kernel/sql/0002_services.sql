-- Services layer, separately ratcheted. All enforcement remains in SQL. Sources: docs/REPLICATE.md.
SET check_function_bodies=false;
CREATE SCHEMA crypto_private;
REVOKE ALL ON SCHEMA crypto_private FROM PUBLIC,backbone_app;
CREATE EXTENSION pgcrypto WITH SCHEMA crypto_private;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA crypto_private FROM PUBLIC;
GRANT USAGE ON SCHEMA crypto_private TO backbone_gov;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA crypto_private TO backbone_gov;
CREATE TABLE ops.run_content_keys(workspace_id uuid,run_id uuid,secret bytea NOT NULL,
  PRIMARY KEY(workspace_id,run_id));
ALTER TABLE ops.run_content_keys OWNER TO backbone_owner;
GRANT SELECT,INSERT,UPDATE,DELETE ON ops.run_content_keys TO backbone_gov;
-- BLOCK private crypto.
CREATE FUNCTION gov._secret() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT encode(crypto_private.gen_random_bytes(32),'hex') $$;
CREATE FUNCTION gov._key(p_run uuid) RETURNS bytea LANGUAGE sql VOLATILE AS $$
  SELECT secret FROM ops.run_content_keys WHERE workspace_id=sec.current_workspace() AND run_id=p_run $$;
CREATE FUNCTION gov._bound_hash(p_run uuid,p_value text) RETURNS text LANGUAGE sql VOLATILE AS $$ SELECT
  encode(crypto_private.hmac(convert_to(
  octet_length(p_value)::text||':'||p_value,'UTF8'),gov._key(p_run),'sha256'),'hex') $$;
-- BLOCK scratch: no governance decision; run/scratch locks give a commit-time fence and consistent snapshot cut.
CREATE TABLE app.scratch_spaces(workspace_id uuid,run_id uuid,head_hash text,
  head_seq int NOT NULL DEFAULT 0,erased_at timestamptz,files_removed_at timestamptz,PRIMARY KEY(workspace_id,run_id),
  FOREIGN KEY(workspace_id,run_id) REFERENCES app.runs);
CREATE TABLE app.scratch_items(workspace_id uuid,run_id uuid,collection text,key text,
  doc jsonb NOT NULL,PRIMARY KEY(workspace_id,run_id,collection,key),
  FOREIGN KEY(workspace_id,run_id) REFERENCES app.scratch_spaces);
CREATE TABLE app.scratch_commits(workspace_id uuid,run_id uuid,seq int,fence bigint NOT NULL,
  base_hash text,tree_hash text NOT NULL,PRIMARY KEY(workspace_id,run_id,seq),
  FOREIGN KEY(workspace_id,run_id) REFERENCES app.runs);
CREATE FUNCTION app.open_run_scratch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO app.scratch_spaces(workspace_id,run_id) VALUES(NEW.workspace_id,NEW.id);
  INSERT INTO ops.run_content_keys VALUES(NEW.workspace_id,NEW.id,crypto_private.gen_random_bytes(32)); RETURN NEW;
END $$;
CREATE TRIGGER scratch AFTER INSERT ON app.runs FOR EACH ROW EXECUTE FUNCTION app.open_run_scratch();
CREATE TRIGGER fence BEFORE INSERT OR UPDATE OR DELETE ON app.scratch_items FOR EACH ROW EXECUTE FUNCTION
  app.scratch_barrier();
CREATE FUNCTION gov._erase(p_run uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Cleanup runs as definer without the worker DML barrier; its only entry is gated owner control.
  DELETE FROM ops.run_content_keys WHERE workspace_id=sec.current_workspace() AND run_id=p_run;
  DELETE FROM app.scratch_commits WHERE run_id=p_run;
  DELETE FROM app.scratch_items WHERE run_id=p_run;
  UPDATE app.scratch_spaces SET erased_at=clock_timestamp(),head_hash=NULL WHERE run_id=p_run;
END $$;
CREATE FUNCTION gov.write_content(p_key text,p_content bytea,p_note bool DEFAULT false,p_execution uuid DEFAULT NULL)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE s record;
BEGIN
  SELECT * INTO STRICT s FROM gov.open_scratch();
  IF p_execution IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.executions WHERE id=p_execution AND
    run_id=s.run_id) THEN PERFORM sec.refuse('execution belongs to another run'); END IF;
  INSERT INTO app.scratch_items VALUES(s.workspace_id,s.run_id,CASE WHEN p_note THEN 'protocol_notes' ELSE
    'protocol_files' END,p_key,jsonb_build_object('bytes',encode(p_content,'base64'),'execution',p_execution))
    ON CONFLICT(workspace_id,run_id,collection,key) DO UPDATE SET doc=excluded.doc;
END $$;
CREATE FUNCTION gov.scratch_files_pending(p_limit int) RETURNS SETOF uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT gov._admin(gov._person()) OR p_limit NOT BETWEEN 1 AND 1000 THEN
    PERFORM sec.refuse('cleanup administrator required'); END IF;
  RETURN QUERY SELECT run_id FROM app.scratch_spaces WHERE erased_at IS NOT NULL AND files_removed_at IS NULL
    ORDER BY run_id LIMIT p_limit;
END $$;
CREATE FUNCTION gov.confirm_scratch_files_removed(p_run uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT gov._admin(gov._person()) THEN PERFORM sec.refuse('cleanup administrator required'); END IF;
  UPDATE app.scratch_spaces SET files_removed_at=clock_timestamp() WHERE run_id=p_run AND erased_at IS NOT NULL
    RETURNING run_id INTO STRICT p_run;
  PERFORM gov._event('scratch.files_removed',jsonb_build_object('run',p_run));
END $$;
CREATE FUNCTION gov.sweep_scratch(p_limit int) RETURNS SETOF uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r app.runs;
BEGIN
  IF NOT gov._admin(gov._person()) OR p_limit NOT BETWEEN 1 AND 1000 THEN
    PERFORM sec.refuse('cleanup administrator required'); END IF;
  FOR r IN SELECT rr.* FROM app.runs rr JOIN app.scratch_spaces s ON s.run_id=rr.id WHERE s.erased_at IS NULL
    AND (SELECT authority_available FROM app.workspaces) AND EXISTS(SELECT 1 FROM app.planes p JOIN sec.contracts c ON
      c.plane_id=ANY(p.path) WHERE p.id=rr.plane_id AND (c.state='revoked' OR
      (c.terms->>'expires')::timestamptz<=clock_timestamp()))
    ORDER BY rr.id LIMIT p_limit FOR UPDATE OF rr LOOP
    UPDATE app.runs SET status='erased',fence=fence+1 WHERE id=r.id;
    PERFORM gov._erase(r.id); PERFORM gov._event('scratch.expired',jsonb_build_object('run',r.id)); RETURN NEXT r.id;
  END LOOP;
END $$;
-- BLOCK reservation services: FIFO tickets, bounded deadlines, interruption backoff, immediate and fair sweep release.
CREATE TABLE app.crossing_reservations(workspace_id uuid,id uuid DEFAULT uuidv7(),intent_id uuid NOT NULL,
  target_id uuid NOT NULL,run_id uuid NOT NULL,ticket bigint GENERATED ALWAYS AS IDENTITY,expires_at timestamptz NOT
  NULL,
  base_head uuid,status text NOT NULL DEFAULT 'waiting' CHECK(status IN('waiting','verifying','released')),reason text,
  PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,intent_id) REFERENCES app.intents);
CREATE UNIQUE INDEX one_verifier ON app.crossing_reservations(workspace_id,target_id) WHERE status='verifying';
ALTER TABLE app.snapshots ADD FOREIGN KEY(workspace_id,reservation_id)
  REFERENCES app.crossing_reservations;
CREATE TABLE app.crossing_backoff(workspace_id uuid,id uuid,target_id uuid,
  interruptions int NOT NULL DEFAULT 0,PRIMARY KEY(workspace_id,id,target_id),
  FOREIGN KEY(workspace_id,id) REFERENCES app.planes,
  FOREIGN KEY(workspace_id,target_id) REFERENCES app.targets);
CREATE FUNCTION gov._release(p_id uuid,p_reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE q app.crossing_reservations;
BEGIN
  UPDATE app.crossing_reservations SET status='released',reason=p_reason WHERE id=p_id AND status<>'released'
    RETURNING * INTO q;
  IF q.id IS NOT NULL AND p_reason IN('expired','interrupted') THEN
    INSERT INTO app.crossing_backoff(workspace_id,id,target_id,interruptions)
      SELECT q.workspace_id,plane_id,q.target_id,1 FROM app.runs WHERE id=q.run_id
      ON CONFLICT(workspace_id,id,target_id) DO UPDATE SET interruptions=app.crossing_backoff.interruptions+1;
  END IF;
END $$;
-- Nothing terminal on either chain: a lapse or narrowing may pass, and landing rechecks.
CREATE FUNCTION gov._held(p_intent uuid) RETURNS bool LANGUAGE sql AS $$ WITH chain AS(SELECT
  sec.run_open(r.id,CASE r.id WHEN i.run_id THEN i.fence ELSE i.checker_fence END) open,c.state,c.owner_id
  FROM app.intents i JOIN app.runs r ON r.id IN(i.run_id,i.checker_run) JOIN app.planes p ON p.id=r.plane_id
  JOIN sec.contracts c ON c.plane_id=ANY(p.path) WHERE i.id=p_intent)
  SELECT bool_and(open AND state='active' AND sec.person_active(owner_id)) FROM chain $$;
CREATE FUNCTION gov._invalidate() RETURNS void LANGUAGE plpgsql AS $$
DECLARE q app.crossing_reservations;
BEGIN
  FOR q IN SELECT * FROM app.crossing_reservations WHERE status<>'released' AND
    -- An outage or a lapse may pass: the reservation's own deadline bounds them, and landing rechecks.
    (expires_at<=clock_timestamp() OR ((SELECT authority_available FROM app.workspaces) AND
      gov._live(intent_id) IS NOT TRUE AND NOT gov._held(intent_id))) ORDER BY ticket LOOP
    PERFORM gov._release(q.id,CASE WHEN q.expires_at<=clock_timestamp() THEN 'expired' ELSE 'authority' END);
  END LOOP;
  PERFORM gov._void_verdicts();
END $$;
CREATE FUNCTION gov.reserve_promotion(p_intent uuid,p_deadline int) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE i app.intents; v uuid;
BEGIN
  PERFORM gov._gate(); PERFORM gov._invalidate();
  SELECT * INTO STRICT i FROM app.intents WHERE id=p_intent AND run_id=sec.current_run();
  IF gov._target_unknown(i.target_id) OR EXISTS(
    SELECT 1 FROM app.verdicts WHERE intent_id=i.id AND consumed_at IS NOT NULL) THEN
    PERFORM sec.refuse('unknown or spent intent','23514'); END IF;
  IF p_deadline NOT BETWEEN 1 AND 60000 OR gov._live(i.id) IS NOT TRUE OR EXISTS(
    SELECT 1 FROM app.crossing_backoff WHERE id=(SELECT plane_id FROM app.runs WHERE id=i.run_id) AND
    target_id=i.target_id AND interruptions>=3) THEN
    PERFORM sec.refuse('reservation refused'); END IF;
  INSERT INTO app.crossing_reservations(workspace_id,intent_id,target_id,run_id,expires_at)
    VALUES(i.workspace_id,i.id,i.target_id,i.run_id,clock_timestamp()+p_deadline*interval '1 millisecond') RETURNING
  id INTO v;
  RETURN v;
END $$;
-- An unknown on a target holds it for every intent, whenever that work joined the queue.
CREATE FUNCTION gov._target_unknown(p_target uuid) RETURNS bool LANGUAGE sql STABLE AS $$ SELECT EXISTS(SELECT 1
  FROM app.verifier_attempts a JOIN app.intents o ON o.id=a.intent_id WHERE o.target_id=p_target AND
  a.disposition='outcome-unknown') $$;
CREATE FUNCTION gov.admit_reservation(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE q app.crossing_reservations; i app.intents; tree text;
BEGIN
  PERFORM gov._gate(); PERFORM gov._invalidate();
  SELECT * INTO STRICT q FROM app.crossing_reservations WHERE id=p_id AND run_id=sec.current_run();
  SELECT * INTO STRICT i FROM app.intents WHERE id=q.intent_id;
  IF q.status<>'waiting' OR gov._target_unknown(q.target_id) OR EXISTS(SELECT 1 FROM app.crossing_reservations WHERE
    target_id=q.target_id AND status<>'released' AND ticket<q.ticket) THEN
    PERFORM gov._release(q.id,'contended');
    RETURN jsonb_build_object('status','contended','attemptId',q.id);
  END IF;
  UPDATE app.crossing_reservations SET status='verifying',base_head=(SELECT head FROM app.targets WHERE
  id=q.target_id) WHERE id=q.id RETURNING * INTO q;
  SELECT head_hash INTO tree FROM app.scratch_spaces WHERE run_id=q.run_id;
  RETURN jsonb_build_object('status','reserved','reservationId',q.id,'attemptId',q.id,'runId',i.run_id,'fence',i.fence,
    'targetId',i.target_id,'baseHead',q.base_head,'tree',tree,'rubricDigest',i.rubric_digest,
    'checkerExecution',i.checkers[1],'checkerExecutions',to_jsonb(i.checkers),
    'remainingMs',extract(epoch FROM q.expires_at-clock_timestamp())*1000);
END $$;
CREATE FUNCTION gov._reservation_live(p_id uuid) RETURNS bool LANGUAGE sql VOLATILE AS $$ SELECT EXISTS(SELECT 1
  FROM app.crossing_reservations
  WHERE id=p_id AND status='verifying' AND expires_at>clock_timestamp()) $$;
CREATE FUNCTION gov.release_reservation(p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM gov._gate();
  IF EXISTS(SELECT 1 FROM app.crossing_reservations WHERE id=p_id AND status='released') THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.crossing_reservations WHERE id=p_id AND run_id=sec.requested_run()) OR
    NOT EXISTS(SELECT 1 FROM app.runs WHERE id=sec.requested_run() AND
    token_hash=sec.token_hash(current_setting('app.run_token',true))) THEN
    PERFORM sec.refuse('reservation holder required'); END IF;
  PERFORM gov._release(p_id,'released');
END $$;
CREATE FUNCTION gov.sweep_crossings() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN PERFORM gov._person(); PERFORM gov._invalidate(); PERFORM gov._expire_holds(); END $$;
CREATE FUNCTION gov.reset_reservation_backoff(p_run uuid,p_target uuid) RETURNS void LANGUAGE plpgsql SECURITY
  DEFINER AS $$
BEGIN
  PERFORM gov._person(true);
  UPDATE app.crossing_backoff SET interruptions=0 WHERE id=(SELECT plane_id FROM app.runs WHERE id=p_run) AND
  target_id=p_target;
  IF NOT FOUND THEN PERFORM sec.refuse('backoff not found','P0002'); END IF;
  PERFORM gov._event('reservation.reset',jsonb_build_object('run',p_run,'target',p_target));
END $$;
-- Reconciliation preserves unknown outcomes until the committed spend is inspected; no blind resend.
CREATE TABLE app.verifier_attempts(workspace_id uuid,id uuid DEFAULT uuidv7(),intent_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,iteration int NOT NULL CHECK(iteration>0),disposition text NOT NULL CHECK(disposition IN(
  'approved-executed','denied-not-executed','execution-error','outcome-unknown')),
  -- Set only when a person settled an unknown their dead checker could not: who, and a digest of what they observed.
  reconciled_by uuid,reconciliation_sha256 text,CHECK((reconciled_by IS NULL)=(reconciliation_sha256 IS NULL)),
  PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,snapshot_id),
  FOREIGN KEY(workspace_id,snapshot_id) REFERENCES app.snapshots,
  FOREIGN KEY(workspace_id,reconciled_by) REFERENCES app.people);
CREATE FUNCTION gov.record_crossing_failure(p_intent uuid,p_snapshot uuid,p_iteration int,p_disposition text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE i app.intents; prior app.verifier_attempts;
BEGIN
  PERFORM gov._gate(); SELECT * INTO STRICT i FROM app.intents WHERE id=p_intent;
  IF sec.current_run() IS DISTINCT FROM i.checker_run OR NOT EXISTS(SELECT 1 FROM app.snapshots WHERE
    id=p_snapshot AND intent_id=i.id) OR p_disposition NOT IN('denied-not-executed','execution-error',
  'outcome-unknown') THEN
    PERFORM sec.refuse('authenticated bound checker required'); END IF;
  -- The one rule for a record that exists: it changes only towards uncertainty, from a failure no person settled,
  -- while the maker is open. Saying it again changes nothing.
  SELECT * INTO prior FROM app.verifier_attempts WHERE snapshot_id=p_snapshot;
  IF prior.disposition<>p_disposition AND NOT (p_disposition='outcome-unknown' AND prior.reconciled_by IS NULL AND
    prior.disposition IN('denied-not-executed','execution-error') AND NOT gov._finished_above(i.run_id)) THEN
    PERFORM sec.refuse('a record is settled','23514'); END IF;
  PERFORM gov._release((SELECT reservation_id FROM app.snapshots WHERE id=p_snapshot),'interrupted');
  INSERT INTO app.verifier_attempts(workspace_id,intent_id,snapshot_id,iteration,disposition)
    VALUES(i.workspace_id,i.id,p_snapshot,p_iteration,p_disposition) ON CONFLICT(workspace_id,snapshot_id)
    DO UPDATE SET disposition=excluded.disposition WHERE app.verifier_attempts.disposition<>excluded.disposition;
  IF FOUND THEN PERFORM gov._event('promotion.attempt_disposition',jsonb_build_object('snapshot',p_snapshot,
    'disposition',p_disposition)); END IF;
END $$;
-- When the checker can no longer report, the door may say only that it does not know. It writes a first unknown and
-- nothing else, so it settles nothing and grants nothing: all it can do is hold a target, which is the trusted-door
-- boundary. Its release is no interruption, so it adds no backoff that would outlast the hold. It names no landing, so the
-- door is trusted to call it only on a lost response. A live checker settles that unknown; past a dead one, its owner.
CREATE FUNCTION gov.record_unknown_crossing(p_intent uuid,p_snapshot uuid,p_iteration int) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE i app.intents; prior text;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'planes_observer' THEN PERFORM sec.refuse('door required'); END IF;
  PERFORM gov._gate(); SELECT * INTO STRICT i FROM app.intents WHERE id=p_intent;
  IF NOT EXISTS(SELECT 1 FROM app.snapshots WHERE id=p_snapshot AND intent_id=i.id) THEN
    PERFORM sec.refuse('a snapshot of this intent required','23514'); END IF;
  SELECT disposition INTO prior FROM app.verifier_attempts WHERE snapshot_id=p_snapshot;
  IF prior='outcome-unknown' THEN RETURN; END IF;
  IF prior IS NOT NULL THEN PERFORM sec.refuse('the door writes a first record only','23514'); END IF;
  PERFORM gov._release((SELECT reservation_id FROM app.snapshots WHERE id=p_snapshot),'door-unknown');
  INSERT INTO app.verifier_attempts(workspace_id,intent_id,snapshot_id,iteration,disposition)
    VALUES(i.workspace_id,i.id,p_snapshot,p_iteration,'outcome-unknown');
  PERFORM gov._event('promotion.attempt_disposition',jsonb_build_object('snapshot',p_snapshot,
    'disposition','outcome-unknown','by','door'));
END $$;
-- A first record is always taken, whatever became of the maker: a landing can commit and lose its response, and that
-- unknown must hold the target even after the maker is erased or finished, so a finished run may carry an unknown. Once
-- a maker is finished or erased (the row no longer says which) an existing record stays: a late checker cannot rewrite
-- what closure relied on. A cancelled maker claims nothing, so moving towards uncertainty still lands.
CREATE FUNCTION gov._finished_above(p_run uuid) RETURNS bool LANGUAGE sql STABLE AS $$
  SELECT EXISTS(WITH RECURSIVE up(id) AS(SELECT p_run UNION SELECT r.parent_run FROM app.runs r JOIN up ON r.id=up.id
    WHERE r.parent_run IS NOT NULL) SELECT 1 FROM up JOIN app.runs a ON a.id=up.id WHERE a.status IN('finished','erased')) $$;
-- Only what was observed settles an unknown: internal state cannot say what an external effect did.
-- Reconciliation is of one snapshot: an intent can have several, and one spent says nothing of another.
CREATE FUNCTION gov._may_settle(p_snapshot uuid,p_observed text) RETURNS bool LANGUAGE sql STABLE AS $$ SELECT
  coalesce(p_observed IN('approved-executed','execution-error'),false) AND (p_observed<>'approved-executed' OR
  EXISTS(SELECT 1 FROM app.verdicts v WHERE v.snapshot_id=p_snapshot AND v.consumed_at IS NOT NULL)) $$;
CREATE FUNCTION gov.reconcile_promotion(p_intent uuid,p_snapshot uuid,p_observed text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE i app.intents;
BEGIN
  PERFORM gov._gate(); SELECT * INTO STRICT i FROM app.intents WHERE id=p_intent;
  IF sec.current_run() IS DISTINCT FROM i.checker_run THEN
    PERFORM sec.refuse('authenticated bound checker required'); END IF;
  IF NOT gov._may_settle(p_snapshot,p_observed) THEN
    PERFORM sec.refuse('an observed outcome this snapshot can have','23514'); END IF;
  UPDATE app.verifier_attempts SET disposition=p_observed WHERE snapshot_id=p_snapshot AND intent_id=i.id AND
    disposition='outcome-unknown';
  IF NOT FOUND THEN PERFORM sec.refuse('only an unknown outcome reconciles','23514'); END IF;
  PERFORM gov._event('promotion.reconciled',jsonb_build_object('intent',i.id,'snapshot',p_snapshot,
    'disposition',p_observed));
  RETURN p_observed;
END $$;
-- The way out when the named checker is gone: the owner of the maker's contract states what they observed at the source,
-- by digest, and it stays on the record with their name. Any contract state will do, since a revoked plane can still
-- hold a target. While the checker lives, at any fence, the checker path is the only one.
CREATE FUNCTION gov.reconcile_promotion_as_owner(p_intent uuid,p_snapshot uuid,p_observed text,p_observation_sha256 text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE person uuid:=gov._person(false,true); i app.intents;
BEGIN
  SELECT * INTO STRICT i FROM app.intents WHERE id=p_intent;
  IF NOT EXISTS(SELECT 1 FROM app.runs r JOIN sec.contracts c ON c.plane_id=r.plane_id WHERE r.id=i.run_id AND
    c.owner_id=person) THEN PERFORM sec.refuse('contract owner required'); END IF;
  IF EXISTS(SELECT 1 FROM app.runs c WHERE c.id=i.checker_run AND sec.run_alive(c.id,c.fence)) THEN
    PERFORM sec.refuse('the named checker is live and reconciles','23514'); END IF;
  IF NOT gov._may_settle(p_snapshot,p_observed) OR coalesce(p_observation_sha256,'')!~'^[0-9a-f]{64}$' THEN
    PERFORM sec.refuse('an observed outcome this snapshot can have','23514'); END IF;
  UPDATE app.verifier_attempts SET disposition=p_observed,reconciled_by=person,reconciliation_sha256=p_observation_sha256
    WHERE snapshot_id=p_snapshot AND intent_id=i.id AND disposition='outcome-unknown';
  IF NOT FOUND THEN PERFORM sec.refuse('only an unknown outcome reconciles','23514'); END IF;
  PERFORM gov._event('promotion.reconciled',jsonb_build_object('intent',i.id,'snapshot',p_snapshot,
    'disposition',p_observed,'by',person,
    'observation',p_observation_sha256));
  RETURN p_observed;
END $$;
-- SQL document captures have a complete stored byte tree; native Git captures retain lineage-wide provenance.
CREATE FUNCTION gov._document_files(p_run uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT
  coalesce(jsonb_agg(jsonb_build_object('path',key,'mode','100644','bytes',doc->>'bytes')
    ORDER BY convert_to(key,'UTF8')),'[]') FROM app.scratch_items WHERE run_id=p_run AND collection='protocol_files' $$;
-- BLOCK freeze/envelope: byte verification and authenticated encryption are services; immutable binding is core.
CREATE FUNCTION gov.freeze_promotion(p_intent uuid,p_tree text,p_files jsonb,p_reservation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE i app.intents; s app.scratch_spaces; q app.crossing_reservations; vector jsonb; manifest jsonb;
  v uuid; content text; digest text; payload bytea;
BEGIN
  PERFORM gov._gate();
  SELECT * INTO STRICT i FROM app.intents WHERE id=p_intent AND run_id=sec.current_run();
  PERFORM 1 FROM app.runs WHERE id=i.run_id FOR SHARE;
  SELECT * INTO STRICT s FROM app.scratch_spaces WHERE run_id=i.run_id FOR UPDATE;
  SELECT * INTO STRICT q FROM app.crossing_reservations WHERE id=p_reservation AND intent_id=i.id;
  IF NOT gov._reservation_live(q.id) OR gov._live(i.id) IS NOT TRUE OR p_tree IS DISTINCT FROM s.head_hash OR
    gov._executions(i.run_id,i.document) IS DISTINCT FROM i.makers OR
    gov._executions(i.checker_run,i.document) IS DISTINCT FROM i.checkers THEN
    PERFORM sec.refuse('stale capture','40001'); END IF;
  IF i.document AND (p_files IS DISTINCT FROM gov._document_files(i.run_id) OR EXISTS(
    SELECT 1 FROM app.scratch_items f WHERE f.run_id=i.run_id AND f.collection='protocol_files' AND
    f.doc->>'bytes'<>'' AND NOT EXISTS(SELECT 1 FROM app.executions e WHERE
      e.id=(f.doc->>'execution')::uuid AND e.run_id=i.run_id))) THEN
    PERFORM sec.refuse('bound SQL document provenance required','23514'); END IF;
  content:=gov._file_digest(p_files);
  IF gov._git_tree(p_files,'',CASE length(p_tree) WHEN 40 THEN 'sha1' ELSE 'sha256' END)<>p_tree THEN
    PERFORM sec.refuse('tree differs from bytes','23514'); END IF;
  vector:=gov._vector(i.id);
  manifest:=jsonb_build_object('intent',i.id,'tree',p_tree,'content',content,'rubric',i.rubric_digest,
    'authority',vector,'makers',to_jsonb(i.makers),'checkers',to_jsonb(i.checkers),'base',q.base_head,
    'fence',i.fence::text,'checkerFence',i.checker_fence::text);
  digest:=gov._bound_hash(i.run_id,gov._jcs(manifest));
  payload:=crypto_private.pgp_sym_encrypt(jsonb_build_object('files',p_files,'manifest',manifest)::text,
    encode(gov._key(i.run_id),'hex'),'compress-algo=1,cipher-algo=aes256,s2k-mode=0');
  INSERT INTO app.snapshots(workspace_id,intent_id,reservation_id,base_head,base_version,run_id,plane_id,
    payload,tree_hash,
    content_sha256,manifest_digest,authority_vector,expires_at,hot)
    SELECT i.workspace_id,i.id,q.id,q.base_head,(SELECT version FROM app.targets WHERE id=i.target_id),
    i.run_id,r.plane_id,payload,gov._bound_hash(i.run_id,p_tree),
    gov._bound_hash(i.run_id,content),
  digest,vector,
    least(q.expires_at,(c.terms->>'expires')::timestamptz),gov._hot(p_files) FROM app.runs r JOIN sec.contracts c ON
      c.plane_id=r.plane_id WHERE r.id=i.run_id RETURNING id INTO v;
  RETURN jsonb_build_object('snapshotId',v,'manifest',manifest,'digest',digest);
END $$;
CREATE FUNCTION gov._snapshot_files(p_snapshot uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s app.snapshots; data jsonb;
BEGIN
  SELECT * INTO STRICT s FROM app.snapshots WHERE id=p_snapshot;
  IF gov._key(s.run_id) IS NULL THEN PERFORM sec.refuse('erased'); END IF;
  data:=crypto_private.pgp_sym_decrypt(s.payload,encode(gov._key(s.run_id),'hex'))::jsonb;
  IF gov._bound_hash(s.run_id,gov._jcs(data->'manifest'))<>s.manifest_digest OR
    gov._bound_hash(s.run_id,data->'manifest'->>'tree')<>s.tree_hash OR
    gov._bound_hash(s.run_id,gov._file_digest(data->'files'))<>s.content_sha256 THEN
    PERFORM sec.refuse('corrupt envelope','23514'); END IF;
  RETURN data->'files';
END $$;
CREATE FUNCTION gov.snapshot_content(p_intent uuid,p_reservation uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY
  DEFINER AS $$
DECLARE s record; files jsonb; tree text;
BEGIN
  PERFORM gov._gate(); SELECT * INTO STRICT s FROM gov._open_scratch();
  PERFORM 1 FROM app.scratch_spaces WHERE run_id=s.run_id FOR UPDATE;
  files:=gov._document_files(s.run_id);
  PERFORM gov._file_digest(files); tree:=gov._git_tree(files,'','sha1');
  INSERT INTO app.scratch_commits VALUES(s.workspace_id,s.run_id,s.head_seq+1,s.fence,s.head_hash,tree);
  UPDATE app.scratch_spaces SET head_hash=tree,head_seq=head_seq+1 WHERE run_id=s.run_id;
  RETURN gov.freeze_promotion(p_intent,tree,files,p_reservation);
END $$;
CREATE FUNCTION gov._file_digest(p_files jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text;
BEGIN
  IF jsonb_typeof(p_files) IS DISTINCT FROM 'array' OR EXISTS ( SELECT 1 FROM jsonb_array_elements(p_files) f WHERE
    jsonb_typeof(f) IS DISTINCT FROM 'object' OR jsonb_typeof(f->'path') IS DISTINCT FROM 'string' OR jsonb_typeof(f->
    'mode') IS DISTINCT FROM 'string' OR jsonb_typeof(f->'bytes') IS DISTINCT FROM 'string' OR f->>'path' IS NULL OR
    f->>'path'='' OR f->>'path' ~ '(^/|//|/$|(^|/)\.{1,2}(/|$))' OR f->>'mode' IS NULL OR f->>'mode' NOT IN ('100644',
    '100755') OR f->>'bytes' IS NULL OR f->>'path' ~* '(^|/)(\.git|\.scratch-copy)(/|$)') OR (SELECT
    count(*)<>count(DISTINCT f->>'path') FROM jsonb_array_elements(p_files) f) THEN
    RAISE EXCEPTION 'malformed complete file tree' USING ERRCODE='check_violation';
  END IF;
  SELECT coalesce(string_agg(octet_length(f->>'path')::text || ':' || (f->>'path') || ':' || (f->>'mode') || ':' ||
    encode(sha256(decode(f->>'bytes', 'base64')), 'hex') || E'\n', '' ORDER BY convert_to(f->>'path', 'UTF8')), '') INTO
    v FROM jsonb_array_elements(p_files) f;
  RETURN encode(sha256(convert_to(v, 'UTF8')), 'hex');
END $$;
CREATE FUNCTION gov._git_tree(p_files jsonb, p_prefix text, p_algo text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE e record;
  v bytea := ''::bytea;
  h bytea;
  b bytea;
  v_mode text;
BEGIN
  FOR e IN SELECT split_part(substring(f->>'path' FROM length(p_prefix)+1), '/', 1) AS name,
    bool_or(strpos(substring(f->>'path' FROM length(p_prefix)+1), '/')>0) AS dir, jsonb_agg(f) AS files FROM
    jsonb_array_elements(p_files) f WHERE starts_with(f->>'path', p_prefix) GROUP BY 1 ORDER BY
    convert_to(split_part(substring(min(f->>'path') FROM length(p_prefix)+1), '/', 1) || CASE WHEN
    bool_or(strpos(substring(f->>'path' FROM length(p_prefix)+1), '/')>0) THEN '/' ELSE '' END, 'UTF8') LOOP
    IF e.dir THEN
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(e.files) f WHERE f->>'path'=p_prefix||e.name) THEN
        RAISE EXCEPTION 'file conflicts with directory' USING ERRCODE='check_violation';
      END IF;
      v_mode := '40000';
      h := decode(gov._git_tree(e.files, p_prefix||e.name||'/', p_algo), 'hex');
    ELSE
      v_mode := e.files->0->>'mode';
      b := decode(e.files->0->>'bytes', 'base64');
      h := crypto_private.digest(convert_to('blob '||octet_length(b)::text, 'UTF8')||decode('00', 'hex')||b, p_algo);
    END IF;
    v := v || convert_to(v_mode||' '||e.name, 'UTF8') || decode('00', 'hex') || h;
  END LOOP;
  RETURN encode(crypto_private.digest(convert_to('tree '||octet_length(v)::text, 'UTF8')||decode('00', 'hex')||v,
    p_algo), 'hex');
END $$;
CREATE FUNCTION gov._utf16(p text) RETURNS int[]
LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce(array_agg(unit ORDER BY n, part), '{}'
  ::int[]) FROM (SELECT n, part, CASE WHEN ascii(substr(p, n, 1))<=65535 THEN ascii(substr(p, n, 1)) WHEN part=1
  THEN 55296+(ascii(substr(p, n, 1))-65536)/1024 ELSE 56320+(ascii(substr(p, n, 1))-65536)%1024 END AS unit FROM
  generate_series(1, length(p)) n CROSS JOIN generate_series(1, 2) part WHERE part=1 OR ascii(substr(p, n, 1))>65535) q
  $$;
CREATE FUNCTION gov._jcs(p jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text;
BEGIN
  CASE jsonb_typeof(p) WHEN 'object' THEN
    SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||gov._jcs(value),
      ',' ORDER BY gov._utf16(key)), '')||'}' INTO v FROM jsonb_each(p);
    WHEN 'array' THEN
    SELECT '['||coalesce(string_agg(gov._jcs(value), ',' ORDER BY n), '')||']' INTO v FROM jsonb_array_elements(p) WITH
      ORDINALITY a(value, n);
    WHEN 'number' THEN
    RAISE EXCEPTION 'manifest numbers must be version strings' USING ERRCODE='check_violation';
  ELSE
    v:=p::text;
  END CASE;
  RETURN v;
END $$;
-- BLOCK packs: finite forbid language and complete effective configurations, not arbitrary policy execution.
CREATE TABLE app.crossing_inputs(workspace_id uuid PRIMARY KEY,metadata jsonb NOT NULL DEFAULT '{}',
  horizon_seconds int NOT NULL DEFAULT 300 CHECK(horizon_seconds BETWEEN 1 AND 300),
  hold_seconds int NOT NULL DEFAULT 86400 CHECK(hold_seconds BETWEEN 1 AND 86400),
  shadow_minimum int NOT NULL DEFAULT 1 CHECK(shadow_minimum>0));
CREATE TABLE app.pack_versions(workspace_id uuid,id uuid DEFAULT uuidv7(),name text NOT NULL,
  config jsonb NOT NULL,classification text NOT NULL CHECK(classification IN('narrowing','loosening')),
  PRIMARY KEY(workspace_id,id));
CREATE TABLE app.pack_heads(workspace_id uuid,id uuid,current_id uuid NOT NULL,PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,current_id) REFERENCES app.pack_versions);
CREATE TABLE app.pack_changes(workspace_id uuid,id uuid DEFAULT uuidv7(),pack_id uuid NOT NULL,
  expected_id uuid,candidate_id uuid NOT NULL,proposer uuid NOT NULL,expires_at timestamptz NOT NULL,
  basis jsonb NOT NULL,proof jsonb NOT NULL,
  PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,candidate_id) REFERENCES app.pack_versions,
  FOREIGN KEY(workspace_id,proposer) REFERENCES app.people);
CREATE TABLE app.pack_samples(workspace_id uuid,id uuid,started_at timestamptz NOT NULL DEFAULT
  clock_timestamp(),evaluations int NOT NULL DEFAULT 0,benign_reviews int NOT NULL DEFAULT 0,
  PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,id) REFERENCES app.pack_versions);
CREATE TABLE app.pack_evaluations(workspace_id uuid,id uuid DEFAULT uuidv7(),pack_id uuid NOT NULL,
  intent_id uuid NOT NULL,result text NOT NULL,PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,pack_id,intent_id),
  FOREIGN KEY(workspace_id,pack_id) REFERENCES app.pack_versions,
  FOREIGN KEY(workspace_id,intent_id) REFERENCES app.intents);
CREATE TABLE app.pack_health(workspace_id uuid,id uuid,status text NOT NULL
  CHECK(status IN('ok','error','timeout')),PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,id) REFERENCES app.pack_versions);
CREATE FUNCTION gov.observe_pack_health(p_version uuid,p_status text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  AS $$
BEGIN
  PERFORM gov._gate();
  IF NOT EXISTS(SELECT 1 FROM app.pack_heads WHERE current_id=p_version) THEN
    PERFORM sec.refuse('current pack version required'); END IF;
  INSERT INTO app.pack_health VALUES(sec.current_workspace(),p_version,p_status) ON CONFLICT(workspace_id,id)
    DO UPDATE SET status=excluded.status;
  PERFORM gov._event('pack.diagnostics',jsonb_build_object('version',p_version,'status',p_status));
END $$;
CREATE TABLE app.crossing_holds(workspace_id uuid,id uuid,snapshot_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,resolved_at timestamptz,class text NOT NULL DEFAULT 'promotion'
  CHECK(class='promotion'),PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,id) REFERENCES app.verdicts);
CREATE TABLE app.outbound_leases(workspace_id uuid,id uuid DEFAULT uuidv7(),run_id uuid NOT NULL,
  fence bigint NOT NULL,contract_vector jsonb NOT NULL,expires_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,run_id) REFERENCES app.runs);
CREATE FUNCTION gov._configuration(p_intent uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT
  jsonb_build_object('inputs',(SELECT jsonb_build_array(metadata,
  horizon_seconds::text,hold_seconds::text,shadow_minimum::text,version::text) FROM app.crossing_inputs),
  'packs',(SELECT coalesce(jsonb_agg(jsonb_build_array(h.id,h.current_id,h.version::text) ORDER BY h.id),'[]')
  FROM app.pack_heads h)) $$;
CREATE FUNCTION gov._pack_config(p jsonb) RETURNS bool LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p-'mayError') key)=
    ARRAY['action','context','effect','forbid','label','mode','plane','producer','selector']::text[] AND
    p->>'mode' IN('shadow','enforce') AND p->>'effect' IN('ok','error','timeout') AND
    sec.valid_set_spec(p->'forbid') AND jsonb_typeof(p->'context')='string' AND
    jsonb_typeof(p->'producer')='string' AND p->>'selector' IN('all','none') AND
    jsonb_typeof(p->'action')='string' AND p->>'label' IN('*','data') AND
    ((NOT p ? 'mayError' AND p->>'action' IN('*','promotion') AND
      (p->'forbid'='"*"' OR sec.set_within(p->'forbid','["promotion"]'))) OR
      (jsonb_typeof(p->'mayError')='boolean' AND
      p->>'producer' IN('static','template','temporal') AND jsonb_typeof(p->'forbid')='array')) AND
    (p->>'plane'='*' OR (p->>'plane')::uuid IS NOT NULL);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION gov._pack_basis() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT
  jsonb_build_object('configuration',gov._configuration(NULL),'planes',(SELECT jsonb_agg(jsonb_build_array(
    p.id,p.parent_id,CASE WHEN c.state<>'revoked' THEN CASE WHEN jsonb_typeof(c.terms->'destinations')='array'
    THEN coalesce((SELECT jsonb_agg(a ORDER BY a) FROM jsonb_array_elements(c.terms->'destinations') a),'[]')
    ELSE c.terms->'destinations' END END) ORDER BY p.id) FROM app.planes p
    LEFT JOIN sec.contracts c ON c.plane_id=p.id)) $$;
CREATE FUNCTION gov._pack_applies(c jsonb,p_path uuid[],p_action text) RETURNS bool LANGUAGE sql IMMUTABLE AS $$
  SELECT c->>'selector'='all' AND c->>'action' IN('*','promotion',p_action) AND c->>'label' IN('*','data') AND
    CASE WHEN c->>'plane'='*' THEN true ELSE (c->>'plane')::uuid=ANY(p_path) END $$;
CREATE FUNCTION gov._forbids(c jsonb,p_path uuid[],p_action text) RETURNS bool LANGUAGE sql IMMUTABLE AS $$
  SELECT c->>'mode'='enforce' AND gov._pack_applies(c,p_path,p_action) AND
    (sec.set_covers(c->'forbid',p_action) OR sec.set_covers(c->'forbid','promotion')) $$;
CREATE FUNCTION gov._pack_shape(c jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT (c-'mode'-'forbid')||
  jsonb_build_object('forbid',CASE WHEN c->'forbid'='"*"' THEN c->'forbid' ELSE
  (SELECT coalesce(jsonb_agg(x ORDER BY x),'[]') FROM (SELECT DISTINCT x FROM jsonb_array_elements(c->'forbid') x) a)
  END,'context',CASE WHEN c->>'context'='-0' THEN '0' ELSE c->>'context' END) $$;
CREATE FUNCTION gov._pack_proof(p_pack uuid,p_new jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE old jsonb; before bool; after bool; representable bool; witnesses jsonb; vacuous jsonb;
BEGIN
  SELECT c.config INTO old FROM app.pack_heads h JOIN app.pack_versions c ON c.id=h.current_id WHERE h.id=p_pack;
  SELECT NOT coalesce(bool_or((c.config->>'mode'='enforce' OR NOT p_new ? 'mayError') AND
    coalesce((c.config->>'mayError')::bool,
    c.config->>'effect'<>'ok')),false),NOT coalesce(bool_or(h.id IS DISTINCT FROM p_pack AND
    (c.config->>'mode'='enforce' OR NOT p_new ? 'mayError') AND coalesce((c.config->>'mayError')::bool,
      c.config->>'effect'<>'ok')),false)
    INTO before,after FROM app.pack_heads h JOIN app.pack_versions c ON c.id=h.current_id;
  after:=after AND NOT ((p_new->>'mode'='enforce' OR NOT p_new ? 'mayError') AND coalesce((p_new->>'mayError')::bool,
    p_new->>'effect'<>'ok'));
  representable:=(NOT p_new ? 'mayError' AND (old IS NULL OR
    (old->'producer'=p_new->'producer' AND old->'context'=p_new->'context'))) OR (p_new->>'producer'='static' AND (old
      IS NULL OR
    (old->>'producer'='static' AND (old->>'context')<>'NaN' AND
    (gov._pack_shape(old)->'context')=(gov._pack_shape(p_new)->'context'))));
  SELECT coalesce(jsonb_agg(jsonb_build_array(p.id,a) ORDER BY p.id,a),'[]') INTO witnesses FROM app.planes p
    JOIN sec.contracts v ON v.plane_id=p.id
    CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN v.terms->'destinations'='"*"' THEN '["promotion"]'
      ELSE v.terms->'destinations' END) a WHERE v.state<>'revoked' AND
    NOT EXISTS(SELECT 1 FROM app.pack_heads h JOIN app.pack_versions c ON c.id=h.current_id WHERE
      h.id IS DISTINCT FROM p_pack AND gov._forbids(c.config,p.path,a)) AND
    coalesce(gov._forbids(old,p.path,a),false) AND NOT gov._forbids(p_new,p.path,a);
  SELECT coalesce(jsonb_agg(a ORDER BY a),'[]') INTO vacuous FROM (SELECT DISTINCT a FROM
    jsonb_array_elements_text(CASE WHEN p_new->'forbid'='"*"' THEN '["promotion"]' ELSE p_new->'forbid' END) a) f
    WHERE NOT EXISTS(SELECT 1 FROM app.planes p JOIN sec.contracts c ON c.plane_id=p.id WHERE c.state<>'revoked'
      AND
      gov._pack_applies(p_new,p.path,a) AND
      sec.set_covers(c.terms->'destinations',a));
  RETURN jsonb_build_object('neverErrors',CASE WHEN p_new ? 'mayError' THEN
    jsonb_build_object('before',before,'after',after) ELSE to_jsonb(before AND after) END,'vacuous',vacuous,
    'representable',representable,'newPermissions',witnesses,'classification',CASE WHEN before AND after AND
    representable AND witnesses='[]' THEN 'narrowing' ELSE 'loosening' END);
END $$;
CREATE FUNCTION gov.propose_pack(p_pack uuid,p_config jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE person uuid:=gov._person(false,true); old uuid; v uuid; ch uuid; proof jsonb;
BEGIN
  IF NOT gov._admin(person) OR gov._pack_config(p_config) IS NOT TRUE THEN
    PERFORM sec.refuse('admin and closed forbid-only policy required'); END IF;
  IF p_config->>'plane'<>'*' AND NOT EXISTS(SELECT 1 FROM app.planes WHERE id=(p_config->>'plane')::uuid) THEN
    PERFORM sec.refuse('pack binding outside workspace'); END IF;
  IF p_pack IS NULL THEN p_pack:=uuidv7(); ELSE
    SELECT current_id INTO old FROM app.pack_heads WHERE id=p_pack;
    IF old IS NULL AND p_config ? 'mayError' THEN PERFORM sec.refuse('unknown pack'); END IF; END IF;
  proof:=gov._pack_proof(p_pack,p_config);
  INSERT INTO app.pack_versions(workspace_id,name,config,classification) VALUES(sec.current_workspace(),p_pack::text,
    p_config,proof->>'classification') RETURNING id INTO v;
  INSERT INTO app.pack_changes(workspace_id,pack_id,expected_id,candidate_id,proposer,expires_at,basis,proof)
    VALUES(sec.current_workspace(),p_pack,old,v,person,clock_timestamp()+interval '5 minutes',gov._pack_basis(),proof)
    RETURNING id INTO ch;
  PERFORM gov._event('pack.proposed',jsonb_build_object('change',ch,'proof',proof)); RETURN ch;
END $$;
CREATE FUNCTION gov.accept_pack(p_change uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE person uuid:=gov._person(false,true); ch app.pack_changes; c app.pack_versions;
BEGIN
  SELECT * INTO STRICT ch FROM app.pack_changes WHERE id=p_change;
  SELECT * INTO STRICT c FROM app.pack_versions WHERE id=ch.candidate_id;
  IF NOT gov._admin(person) OR person=ch.proposer OR NOT gov._admin(ch.proposer) OR ch.expires_at<=clock_timestamp() OR
    (SELECT current_id FROM app.pack_heads WHERE id=ch.pack_id) IS DISTINCT FROM ch.expected_id OR
    ch.basis IS DISTINCT FROM gov._pack_basis() THEN
    PERFORM sec.refuse('two fresh administrators required'); END IF;
  IF c.config->>'mode'='enforce' AND NOT EXISTS(SELECT 1 FROM app.pack_samples s JOIN app.pack_versions old ON
  old.id=s.id
    WHERE (s.id=ch.expected_id OR c.config ? 'mayError') AND old.config->>'mode'='shadow' AND
    gov._pack_shape(old.config)=gov._pack_shape(c.config) AND s.started_at<=clock_timestamp()-interval '7 days' AND
    s.evaluations>=(SELECT shadow_minimum FROM app.crossing_inputs) AND s.benign_reviews>0) THEN
    PERFORM sec.refuse('shadow evidence missing for exact configuration','23514'); END IF;
  INSERT INTO app.pack_heads(workspace_id,id,current_id) VALUES(sec.current_workspace(),ch.pack_id,c.id)
    ON CONFLICT(workspace_id,id) DO UPDATE SET current_id=excluded.current_id;
  INSERT INTO app.pack_samples(workspace_id,id) VALUES(sec.current_workspace(),c.id);
  INSERT INTO app.pack_health SELECT workspace_id,c.id,status FROM app.pack_health WHERE id=ch.expected_id;
  PERFORM gov._event('pack.changed',jsonb_build_object('change',p_change,'version',c.id)); RETURN c.id;
END $$;
CREATE FUNCTION gov.review_pack_sample(p_version uuid,p_intent uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  AS $$
BEGIN
  IF NOT gov._admin(gov._person()) OR NOT EXISTS(SELECT 1 FROM app.pack_evaluations WHERE pack_id=p_version AND
    intent_id=p_intent) THEN PERFORM sec.refuse('review requires an evaluated example'); END IF;
  UPDATE app.pack_samples SET benign_reviews=benign_reviews+1 WHERE id=p_version;
  PERFORM gov._event('pack.benign_review',jsonb_build_object('version',p_version,'intent',p_intent));
END $$;
CREATE FUNCTION gov._pack_result(p_intent uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE p app.pack_versions; path uuid[]; action text; result text; held bool:=false; denied bool:=false;
BEGIN
  SELECT wp.path,i.action INTO path,action FROM app.intents i JOIN app.runs r ON r.id=i.run_id
    JOIN app.planes wp ON wp.id=r.plane_id WHERE i.id=p_intent;
  FOR p IN SELECT pv.* FROM app.pack_heads h JOIN app.pack_versions pv ON pv.id=h.current_id ORDER BY h.id LOOP
    IF gov._pack_applies(p.config,path,action) THEN
      result:=CASE WHEN p.config->>'effect'<>'ok' OR coalesce((SELECT status FROM app.pack_health WHERE id=p.id),
  'ok')<>'ok'
        THEN 'error' WHEN sec.set_covers(p.config->'forbid',action) OR sec.set_covers(p.config->'forbid','promotion')
        THEN 'forbid' ELSE 'allow' END;
      INSERT INTO app.pack_evaluations(workspace_id,pack_id,intent_id,result)
        VALUES(p.workspace_id,p.id,p_intent,result) ON CONFLICT DO NOTHING;
      IF FOUND THEN UPDATE app.pack_samples SET evaluations=evaluations+1 WHERE id=p.id; END IF;
      IF p.config->>'mode'='enforce' THEN
        IF result='error' THEN held:=true; ELSIF result='forbid' THEN denied:=true; END IF;
      END IF;
    END IF;
  END LOOP;
  RETURN CASE WHEN held THEN 'hold' WHEN denied THEN 'deny' ELSE 'allow' END;
END $$;
CREATE FUNCTION gov._hold(p_verdict uuid,p_snapshot uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE h app.crossing_holds;
BEGIN
  INSERT INTO app.crossing_holds(workspace_id,id,snapshot_id,expires_at) SELECT s.workspace_id,p_verdict,s.id,
    least(clock_timestamp()+coalesce((ci.metadata#>>'{operationClasses,promotion,holdSeconds}')::int,
      ci.hold_seconds)*interval '1 second',(SELECT min((cv.terms->>'expires')::timestamptz)
      FROM jsonb_array_elements(s.authority_vector->'contracts') a JOIN app.contracts cv ON
  cv.id=(a->>1)::uuid))
    FROM app.snapshots s CROSS JOIN app.crossing_inputs ci WHERE s.id=p_snapshot RETURNING * INTO STRICT h;
  PERFORM gov._event('release.held',jsonb_build_object('verdict',p_verdict,'reason','pack','executed',false));
  RETURN jsonb_build_object('class',h.class,'expires_at',h.expires_at);
END $$;
CREATE FUNCTION gov._expire_holds() RETURNS void LANGUAGE plpgsql AS $$
DECLARE h app.crossing_holds;
BEGIN
  FOR h IN UPDATE app.crossing_holds SET resolved_at=clock_timestamp() WHERE resolved_at IS NULL AND
    expires_at<=clock_timestamp() RETURNING * LOOP
    PERFORM gov._event('release.denied',jsonb_build_object('verdict',h.id,'outcome','denied-not-executed',
      'reason','hold_expired','resolver','expiry','at',h.resolved_at::text));
  END LOOP;
END $$;
CREATE FUNCTION gov.set_crossing_inputs(p_metadata jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM gov._person(true);
  IF jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' OR (p_metadata#>'{operationClasses,promotion,holdSeconds}'
    IS NOT NULL AND coalesce((p_metadata#>>'{operationClasses,promotion,holdSeconds}')::int,0) NOT BETWEEN 1 AND
  86400) THEN
    PERFORM sec.refuse('bounded operation-class hold duration required','23514'); END IF;
  PERFORM gov._jcs(p_metadata);
  UPDATE app.crossing_inputs SET metadata=p_metadata;
  PERFORM gov._event('defaults.changed',jsonb_build_object('metadata',p_metadata));
END $$;
-- H caps only already exported instruments. Issuance and each subsequent use read online authority.
CREATE FUNCTION gov.issue_outbound_lease(p_run uuid,p_fence bigint) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v uuid;
BEGIN
  PERFORM gov._gate();
  IF NOT sec.run_alive(p_run,p_fence) THEN PERFORM sec.refuse('live run required'); END IF;
  INSERT INTO app.outbound_leases(workspace_id,run_id,fence,contract_vector,expires_at)
    SELECT r.workspace_id,r.id,r.fence,(SELECT jsonb_agg(jsonb_build_array(h.id,h.current_id) ORDER BY h.id)
    FROM app.contract_heads h WHERE h.id=ANY(p.path)),least(clock_timestamp()+ci.horizon_seconds*interval '1 second',
    (SELECT min((cv.terms->>'expires')::timestamptz) FROM sec.contracts cv WHERE cv.plane_id=ANY(p.path))) FROM app.runs
      r JOIN app.planes p ON p.id=r.plane_id
    CROSS JOIN app.crossing_inputs ci WHERE r.id=p_run RETURNING id INTO v; RETURN v;
END $$;
CREATE FUNCTION gov.issue_outbound_lease(p_run uuid,p_fence bigint,p_secret text) RETURNS uuid
LANGUAGE plpgsql STRICT SECURITY DEFINER AS $$
BEGIN
  PERFORM gov._gate();
  IF sec.current_run() IS DISTINCT FROM p_run OR p_secret IS DISTINCT FROM current_setting('app.run_token',true)
    THEN PERFORM sec.refuse('full run handle required'); END IF;
  RETURN gov.issue_outbound_lease(p_run,p_fence);
END $$;
CREATE FUNCTION gov.read_landing(p_verdict uuid) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER AS $$
  SELECT files FROM app.artifacts WHERE id=p_verdict AND sec.plane_visible(plane_id) $$;
CREATE FUNCTION gov.dump_crossing_rows() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE t record; rows jsonb; result jsonb:='{}';
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'planes_observer' THEN
    PERFORM sec.refuse('audit runtime required'); END IF;
  PERFORM gov._gate();
  PERFORM gov._event('audit.export','{}');
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='app' ORDER BY tablename LOOP
    EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r)),''[]'') FROM app.%I r',t.tablename) INTO rows;
    result:=result||jsonb_build_object(t.tablename,rows);
  END LOOP; RETURN result;
END $$;
-- Effects leaving the plane. The door is the only caller: it assigns the class from the effect, so a run
-- cannot classify its own work. A receipt proves the authorisation; completion is the settled outcome.
-- The class is a number a signed ceiling limits, on the scale ceilings have always used: 2 changes the person's own
-- work and can be undone exactly (document), 3 changes something outside it with an exact undo (external), 4 cannot be
-- undone exactly (irreversible). A read is 1 and makes no attempt. SQL cannot see the effect: the door's class is
-- trusted, and only the closed set and the key's binding are checked here.
CREATE TABLE app.effect_attempts(workspace_id uuid,id uuid DEFAULT uuidv7(),run_id uuid NOT NULL,fence bigint NOT NULL,
  class text NOT NULL CHECK(class IN('document','external','irreversible')),tool text NOT NULL CHECK(tool ~ '^[a-z0-9._-]{1,64}$'),
  operation text NOT NULL CHECK(operation ~ '^[a-z0-9._-]{1,64}$'),
  -- Digests and tokens only: nothing here can hold content that erasure would have to reach.
  target_sha256 text NOT NULL CHECK(target_sha256 ~ '^[0-9a-f]{64}$'),
  args_sha256 text NOT NULL CHECK(args_sha256 ~ '^[0-9a-f]{64}$'),key text NOT NULL CHECK(key ~ '^[0-9a-f]{64}$'),
  cost numeric NOT NULL CHECK(cost>=0),
  status text NOT NULL DEFAULT 'attempted' CHECK(status IN('held','attempted','claimed','dispatching','executed','denied',
    'failed','unknown')),claim_hash text,lease_expires_at timestamptz,reconciliation_sha256 text,
  -- Who took a held row out, under which contract version. Written once: the row's digests are the effect accepted.
  accepted_by uuid,accepted_contract uuid,CHECK((accepted_by IS NULL)=(accepted_contract IS NULL)),
  effect_class int NOT NULL CHECK(effect_class=CASE class WHEN 'document' THEN 2 WHEN 'external' THEN 3 ELSE 4 END),
  PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,key),
  FOREIGN KEY(workspace_id,run_id) REFERENCES app.runs(workspace_id,id),
  FOREIGN KEY(workspace_id,accepted_by) REFERENCES app.people,
  FOREIGN KEY(workspace_id,accepted_contract) REFERENCES app.contracts(workspace_id,id));
CREATE FUNCTION app.attempt_invariant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['status','claim_hash','lease_expires_at','reconciliation_sha256','accepted_by',
    'accepted_contract']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','claim_hash','lease_expires_at',
    'reconciliation_sha256','accepted_by','accepted_contract']) OR OLD.status IN('executed','denied','failed') THEN
    PERFORM sec.refuse('an attempt is immutable once settled','23514'); END IF;
  -- Only a person's acceptance leaves held for anything but denied, and it is one act on one held row.
  IF (OLD.status='held' AND NEW.status NOT IN('held','denied') AND NEW.accepted_by IS NULL) OR
    (OLD.accepted_by IS NOT NULL AND ((NEW.accepted_by,NEW.accepted_contract) IS DISTINCT FROM
    (OLD.accepted_by,OLD.accepted_contract) OR NEW.status='held')) OR
    (OLD.accepted_by IS NULL AND NEW.accepted_by IS NOT NULL AND OLD.status<>'held') THEN
    PERFORM sec.refuse('acceptance is once, on a held attempt','23514'); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invariant BEFORE UPDATE OR DELETE ON app.effect_attempts FOR EACH ROW EXECUTE FUNCTION
  app.attempt_invariant();
-- Attempts spent against one plane, by runs on it or below it. Unknown stays charged; denied never acted.
CREATE FUNCTION gov._spent(p_plane uuid) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT coalesce(sum(a.cost),0)
  FROM app.effect_attempts a JOIN app.runs r ON r.id=a.run_id JOIN app.planes p ON p.id=r.plane_id
  WHERE p_plane=ANY(p.path) AND a.status<>'denied' $$;
-- Everything that must still hold for an attempt to go out. Checked at attempt, claim and begin: terms can
-- narrow, a run can close and another attempt on the target can turn unknown between any two of them. A
-- dispatching one holds its target too, lapsed or live, or a second door could go out beside it.
CREATE FUNCTION gov._target_held(e app.effect_attempts) RETURNS bool LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM app.effect_attempts o WHERE o.target_sha256=e.target_sha256 AND
    o.status IN('unknown','dispatching') AND o.id IS DISTINCT FROM e.id) $$;
-- Above a ceiling on the run's chain, unless a person accepted it under the plane's current contract. A live chain has
-- its tightest ceiling on the run's own plane, so an acceptance answers for the whole chain.
CREATE FUNCTION gov._over_ceiling(e app.effect_attempts) RETURNS bool LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM app.runs r JOIN app.planes p ON p.id=r.plane_id JOIN sec.contracts c ON c.plane_id=ANY(p.path)
    WHERE r.id=e.run_id AND e.effect_class>(c.terms->>'ceiling')::int AND e.accepted_contract IS DISTINCT FROM
      (SELECT o.id FROM sec.contracts o WHERE o.plane_id=r.plane_id)) $$;
CREATE FUNCTION gov._may_go(e app.effect_attempts,p_counted bool) RETURNS bool LANGUAGE sql STABLE AS $$
  SELECT sec.run_alive(e.run_id,e.fence) AND NOT gov._target_held(e) AND (e.status='held' OR NOT gov._over_ceiling(e)) AND
    coalesce((SELECT bool_and(sec.set_covers(c.terms->'tools',e.tool) AND sec.set_covers(c.terms->'destinations',
      e.operation) AND gov._spent(c.plane_id)+CASE WHEN p_counted THEN 0 ELSE e.cost END<=(c.terms->>'budget')::numeric)
    FROM app.runs r JOIN app.planes p ON p.id=r.plane_id JOIN sec.contracts c ON c.plane_id=ANY(p.path)
    WHERE r.id=e.run_id),false) $$;
-- What may lift waits, with no claim on it. A row above the ceiling waits for a person, whatever lifts.
CREATE FUNCTION gov._wait(e app.effect_attempts) RETURNS void LANGUAGE plpgsql AS $$
DECLARE over bool:=gov._over_ceiling(e);
BEGIN
  UPDATE app.effect_attempts SET status=CASE WHEN over THEN 'held' ELSE 'attempted' END,claim_hash=NULL,lease_expires_at=NULL
    WHERE id=e.id;
  IF over THEN PERFORM gov._event('effect.held',jsonb_build_object('attempt',e.id,'class',e.effect_class)); END IF;
END $$;
CREATE FUNCTION gov.attempt_effect(p_run uuid,p_fence bigint,p_class text,p_tool text,p_operation text,
  p_target_sha256 text,p_args_sha256 text,p_key text,p_cost numeric) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE e app.effect_attempts; v uuid;
BEGIN
  PERFORM gov._gate();
  SELECT * INTO e FROM app.effect_attempts WHERE key=p_key;
  IF FOUND THEN
    IF (e.run_id,e.fence,e.class,e.tool,e.operation,e.target_sha256,e.args_sha256,e.cost) IS DISTINCT FROM
      (p_run,p_fence,p_class,p_tool,p_operation,p_target_sha256,p_args_sha256,p_cost) THEN
      PERFORM sec.refuse('reused key','23514'); END IF;
    RETURN e.id;
  END IF;
  e:=ROW(sec.current_workspace(),uuidv7(),p_run,p_fence,p_class,p_tool,p_operation,p_target_sha256,p_args_sha256,p_key,
    p_cost,'attempted',NULL,NULL,NULL,NULL,NULL,CASE p_class WHEN 'document' THEN 2 WHEN 'external' THEN 3 ELSE 4 END);
  -- Checked under the gate that closing a run also takes, so nothing can follow a closed run in.
  IF gov._target_held(e) THEN PERFORM sec.refuse('target held','55006'); END IF;
  -- Everything but the ceiling still refuses a proposal: a person accepts what was signed for, and no more.
  IF gov._over_ceiling(e) THEN e.status:='held'; END IF;
  IF NOT gov._may_go(e,false) THEN PERFORM sec.refuse('attempt refused','23514'); END IF;
  INSERT INTO app.effect_attempts SELECT (e).*;
  PERFORM gov._event('effect.attempted',jsonb_build_object('attempt',e.id,'run',p_run,'class',p_class));
  IF e.status='held' THEN
    PERFORM gov._event('effect.held',jsonb_build_object('attempt',e.id,'class',e.effect_class)); END IF;
  RETURN e.id;
END $$;
-- A person takes one held proposal out, or refuses it. What they saw is named here and must be the row's. Only the
-- owner of the run's contract accepts; an administrator may also refuse, and a refusal needs no live run or authority.
CREATE FUNCTION gov.accept_attempt(p_id uuid,p_target_sha256 text,p_args_sha256 text) RETURNS void LANGUAGE plpgsql
SECURITY DEFINER AS $$
DECLARE person uuid:=gov._person(false,true); e app.effect_attempts; c app.contracts;
BEGIN
  SELECT * INTO STRICT e FROM app.effect_attempts WHERE id=p_id;
  SELECT cv.* INTO STRICT c FROM app.runs r JOIN sec.contracts cv ON cv.plane_id=r.plane_id WHERE r.id=e.run_id;
  IF c.owner_id<>person THEN PERFORM sec.refuse('contract owner required'); END IF;
  IF e.status<>'held' OR NOT sec.run_alive(e.run_id,e.fence) OR
    (e.target_sha256,e.args_sha256) IS DISTINCT FROM (p_target_sha256,p_args_sha256) THEN
    PERFORM sec.refuse('this held attempt, as proposed, on a live run','23514'); END IF;
  UPDATE app.effect_attempts SET status='attempted',accepted_by=person,accepted_contract=c.id WHERE id=p_id;
  PERFORM gov._event('effect.accepted',jsonb_build_object('attempt',p_id,'by',person,'contract',c.id,
    'target',e.target_sha256,'args',e.args_sha256));
END $$;
CREATE FUNCTION gov.deny_attempt(p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE person uuid:=gov._person(); e app.effect_attempts;
BEGIN
  SELECT * INTO STRICT e FROM app.effect_attempts WHERE id=p_id;
  IF NOT gov._admin(person) AND NOT EXISTS(SELECT 1 FROM app.runs r JOIN sec.contracts c ON c.plane_id=r.plane_id
    WHERE r.id=e.run_id AND c.owner_id=person) THEN PERFORM sec.refuse('contract owner or administrator required'); END IF;
  IF e.status<>'held' THEN PERFORM sec.refuse('only a held attempt is refused','23514'); END IF;
  UPDATE app.effect_attempts SET status='denied' WHERE id=p_id;
  PERFORM gov._event('effect.denied',jsonb_build_object('attempt',p_id,'by',person));
END $$;
CREATE FUNCTION gov.claim_attempt(p_id uuid,p_lease_ms int) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE e app.effect_attempts; claim text:=gov._secret();
BEGIN
  PERFORM gov._gate();
  SELECT * INTO STRICT e FROM app.effect_attempts WHERE id=p_id;
  IF p_lease_ms NOT BETWEEN 1 AND 60000 OR NOT (e.status IN('held','attempted') OR
    (e.status='claimed' AND e.lease_expires_at<=clock_timestamp())) THEN PERFORM sec.refuse('not claimable','23514'); END IF;
  IF e.status='held' AND sec.run_alive(e.run_id,e.fence) THEN PERFORM sec.refuse('attempt held','55006'); END IF;
  -- A closed run ends an attempt, and so does a new contract its acceptance no longer covers: an acceptance is one act
  -- under one contract, so it does not wait to be spent under another. A hold or narrowed terms may lift, so it waits.
  IF NOT sec.run_alive(e.run_id,e.fence) OR (e.accepted_by IS NOT NULL AND gov._over_ceiling(e)) THEN
    UPDATE app.effect_attempts SET status='denied',claim_hash=NULL,lease_expires_at=NULL WHERE id=p_id;
    PERFORM gov._event('effect.denied',jsonb_build_object('attempt',p_id)); RETURN NULL;
  END IF;
  IF NOT gov._may_go(e,true) THEN PERFORM gov._wait(e); RETURN NULL; END IF;
  UPDATE app.effect_attempts SET status='claimed',claim_hash=sec.token_hash(claim),
    lease_expires_at=clock_timestamp()+p_lease_ms*interval '1 millisecond' WHERE id=p_id;
  RETURN claim;
END $$;
-- The door names what it is about to send, so a change after the attempt is caught here, not after. An accepted
-- effect is one target and one set of arguments, so it must name both.
CREATE FUNCTION gov.begin_attempt(p_id uuid,p_claim text,p_args_sha256 text,p_target_sha256 text DEFAULT NULL) RETURNS bool
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE e app.effect_attempts;
BEGIN
  PERFORM gov._gate();
  SELECT * INTO e FROM app.effect_attempts WHERE id=p_id AND status='claimed' AND claim_hash=sec.token_hash(p_claim)
    AND lease_expires_at>clock_timestamp();
  IF NOT FOUND THEN RETURN false; END IF;
  IF e.args_sha256 IS DISTINCT FROM p_args_sha256 OR NOT sec.run_alive(e.run_id,e.fence) OR
    (e.accepted_by IS NOT NULL AND (e.target_sha256 IS DISTINCT FROM p_target_sha256 OR gov._over_ceiling(e))) THEN
    UPDATE app.effect_attempts SET status='denied',claim_hash=NULL,lease_expires_at=NULL WHERE id=p_id;
    PERFORM gov._event('effect.denied',jsonb_build_object('attempt',p_id)); RETURN false;
  END IF;
  IF NOT gov._may_go(e,true) THEN PERFORM gov._wait(e); RETURN false; END IF;
  UPDATE app.effect_attempts SET status='dispatching' WHERE id=p_id;
  PERFORM gov._event('effect.dispatching',jsonb_build_object('attempt',p_id)); RETURN true;
END $$;
CREATE FUNCTION gov.settle_attempt(p_id uuid,p_claim text,p_outcome text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM gov._gate();
  IF p_outcome IS NULL OR p_outcome NOT IN('executed','failed','unknown') THEN
    PERFORM sec.refuse('unknown outcome class','23514'); END IF;
  UPDATE app.effect_attempts SET status=p_outcome,claim_hash=NULL,lease_expires_at=NULL WHERE id=p_id AND
    status='dispatching' AND claim_hash=sec.token_hash(p_claim);
  IF NOT FOUND THEN PERFORM sec.refuse('not dispatching under this claim','23514'); END IF;
  PERFORM gov._event('effect.settled',jsonb_build_object('attempt',p_id,'outcome',p_outcome));
END $$;
-- A closed run's waiting attempts are over, and what they reserved goes back, with no claim needed. Claimed ones are
-- left: their holder may still be between claim and begin, and begin ends them.
CREATE FUNCTION gov._end_attempts(p_run uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a uuid;
BEGIN
  FOR a IN WITH RECURSIVE down(id) AS(SELECT p_run UNION SELECT r.id FROM app.runs r JOIN down ON r.parent_run=down.id)
    SELECT e.id FROM app.effect_attempts e JOIN down ON e.run_id=down.id
    WHERE e.status IN('held','attempted') AND NOT sec.run_open(e.run_id,e.fence) LOOP
    UPDATE app.effect_attempts SET status='denied' WHERE id=a;
    PERFORM gov._event('effect.denied',jsonb_build_object('attempt',a,'by','close'));
  END LOOP;
END $$;
-- A silent dispatcher becomes unknown, never failed: it may have acted. Nothing here resends. A closed run's attempts end
-- here too, whatever closed it: a reclaim or a rotated parent leaves them behind, and a lapsed claim on one is abandoned.
-- A lapsed claim on an open run stays reclaimable, and a lapsed contract or an outage closes no run.
CREATE FUNCTION gov.sweep_attempts() RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r record; n int:=0;
BEGIN
  PERFORM gov._gate();
  FOR r IN SELECT id FROM app.effect_attempts WHERE (status IN('held','attempted') OR (status='claimed' AND
    lease_expires_at<=clock_timestamp())) AND NOT sec.run_open(run_id,fence) LOOP
    UPDATE app.effect_attempts SET status='denied',claim_hash=NULL,lease_expires_at=NULL WHERE id=r.id;
    PERFORM gov._event('effect.denied',jsonb_build_object('attempt',r.id,'by','sweep')); n:=n+1;
  END LOOP;
  FOR r IN SELECT id FROM app.effect_attempts WHERE status='dispatching' AND lease_expires_at<=clock_timestamp() LOOP
    UPDATE app.effect_attempts SET status='unknown',claim_hash=NULL,lease_expires_at=NULL WHERE id=r.id;
    PERFORM gov._event('effect.settled',jsonb_build_object('attempt',r.id,'outcome','unknown','by','sweep')); n:=n+1;
  END LOOP; RETURN n;
END $$;
-- Only what the door observed at the source settles an unknown, and it stays on the record. SQL cannot prove the
-- door saw it, or that a paused dispatcher will not still send: that needs a fence at the door. See the port plan.
CREATE FUNCTION gov.reconcile_attempt(p_id uuid,p_outcome text,p_observation_sha256 text) RETURNS void LANGUAGE plpgsql
SECURITY DEFINER AS $$
BEGIN
  PERFORM gov._gate();
  IF p_outcome IS NULL OR p_outcome NOT IN('executed','failed') OR coalesce(p_observation_sha256,'')!~'^[0-9a-f]{64}$' THEN
    PERFORM sec.refuse('reconciliation names an observed outcome','23514'); END IF;
  UPDATE app.effect_attempts SET status=p_outcome,reconciliation_sha256=p_observation_sha256 WHERE id=p_id AND status='unknown';
  IF NOT FOUND THEN PERFORM sec.refuse('only an unknown outcome reconciles','23514'); END IF;
  PERFORM gov._event('effect.reconciled',jsonb_build_object('attempt',p_id,'outcome',p_outcome,'observation',p_observation_sha256));
END $$;
-- The door ends a run. This only narrows: it needs no person, so recovery can close a dead process's run
-- unattended. Finished claims the work is done as far as is known at close: a check then, not a promise for later. The
-- run must still hold its authority, and nothing of it, no child, attempt or promotion, may still be open or unknown.
-- Cancelled needs none of that.
CREATE FUNCTION gov._subtree_open(p_run uuid) RETURNS bool LANGUAGE sql AS $$
  WITH RECURSIVE down(id) AS(SELECT p_run UNION SELECT r.id FROM app.runs r JOIN down ON r.parent_run=down.id)
  SELECT EXISTS(SELECT 1 FROM app.runs r JOIN down USING(id) WHERE r.id<>p_run AND r.status='running') OR
    EXISTS(SELECT 1 FROM app.effect_attempts a JOIN down ON a.run_id=down.id
      WHERE a.status NOT IN('executed','denied','failed')) OR
    EXISTS(SELECT 1 FROM app.crossing_reservations q JOIN down ON q.run_id=down.id WHERE q.status<>'released') OR
    EXISTS(SELECT 1 FROM app.verifier_attempts a JOIN app.intents i ON i.id=a.intent_id JOIN down ON i.run_id=down.id
      WHERE a.disposition='outcome-unknown') $$;
CREATE FUNCTION gov.close_run(p_run uuid,p_fence bigint,p_status text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM gov._gate();
  PERFORM gov._invalidate();
  IF p_status IS NULL OR p_status NOT IN('finished','cancelled') OR (p_status='finished' AND (
    NOT sec.run_alive(p_run,p_fence) OR gov._subtree_open(p_run))) THEN
    PERFORM sec.refuse('run cannot close this way','23514'); END IF;
  UPDATE app.runs SET status=p_status,fence=fence+1,token_hash=sec.token_hash(gov._secret())
    WHERE id=p_run AND fence=p_fence AND status='running';
  IF NOT FOUND THEN PERFORM sec.refuse('not a running run at this fence','23514'); END IF;
  PERFORM gov._end_attempts(p_run);
  PERFORM gov._event('run.closed',jsonb_build_object('run',p_run,'status',p_status));
END $$;
-- What the door needs after a restart. No claim hash: a read must not hand out a dispatch.
CREATE FUNCTION gov.read_run(p_run uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT jsonb_build_object('id',id,'task',task_id,'plane',plane_id,'status',status,'fence',fence::text) FROM app.runs
  WHERE id=p_run $$;
CREATE FUNCTION gov.read_attempts(p_run uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(a)-'claim_hash' ORDER BY a.id),'[]') FROM app.effect_attempts a WHERE a.run_id=p_run $$;
-- BLOCK installation. No service may bypass the tenant wall or mutate core through policy configuration.
SELECT gov._install();
CREATE POLICY own ON app.scratch_items FOR ALL TO backbone_app USING(run_id=sec.current_run())
  WITH CHECK(run_id=sec.current_run());
GRANT SELECT,INSERT,UPDATE,DELETE ON app.scratch_items TO backbone_app;
GRANT EXECUTE ON FUNCTION gov.write_content(text,bytea,bool,uuid),gov.reserve_promotion(uuid,int),
  gov.admit_reservation(uuid),gov.release_reservation(uuid),gov.sweep_crossings(),
  gov.reset_reservation_backoff(uuid,uuid),gov.freeze_promotion(uuid,text,jsonb,uuid),gov.snapshot_content(uuid,uuid),
  gov.propose_pack(uuid,jsonb),gov.record_crossing_failure(uuid,uuid,int,text),gov.reconcile_promotion(uuid,uuid,text),
  gov.sweep_scratch(int),gov.scratch_files_pending(int),gov.confirm_scratch_files_removed(uuid),
  gov.accept_pack(uuid),gov.review_pack_sample(uuid,uuid),gov.set_crossing_inputs(jsonb),gov.read_landing(uuid)
  TO backbone_app;
GRANT EXECUTE ON FUNCTION gov.accept_attempt(uuid,text,text),gov.deny_attempt(uuid) TO backbone_app;
GRANT EXECUTE ON FUNCTION gov.attempt_effect(uuid,bigint,text,text,text,text,text,text,numeric),gov.claim_attempt(uuid,int),
  gov.begin_attempt(uuid,text,text,text),gov.settle_attempt(uuid,text,text),gov.sweep_attempts(),
  gov.reconcile_attempt(uuid,text,text),gov.close_run(uuid,bigint,text),gov.read_run(uuid),gov.read_attempts(uuid)
  TO planes_observer;
GRANT EXECUTE ON FUNCTION gov.record_unknown_crossing(uuid,uuid,int) TO planes_observer;
GRANT EXECUTE ON FUNCTION gov.reconcile_promotion_as_owner(uuid,uuid,text,text) TO backbone_app;
GRANT EXECUTE ON FUNCTION gov.dump_crossing_rows(),gov.issue_outbound_lease(uuid,bigint),
  gov.issue_outbound_lease(uuid,bigint,text),
  gov.observe_pack_health(uuid,text) TO planes_observer;
SET check_function_bodies=true;
