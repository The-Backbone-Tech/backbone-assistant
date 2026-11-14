-- Core: decision 0006; sources/licences: docs/REPLICATE.md.
-- Owner/crossing locks: workspace first; in-plane: run -> scratch.
-- The transaction barrier forbids mixing these orders.
SET check_function_bodies=false;
CREATE SCHEMA app AUTHORIZATION backbone_owner;
CREATE SCHEMA sec AUTHORIZATION backbone_owner;
CREATE SCHEMA gov AUTHORIZATION backbone_owner;
CREATE SCHEMA ops AUTHORIZATION backbone_owner;
CREATE TABLE ops.schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz DEFAULT
  now());
ALTER TABLE ops.schema_migrations OWNER TO backbone_owner;
REVOKE ALL ON SCHEMA app,sec,gov,ops FROM PUBLIC;
GRANT USAGE ON SCHEMA app,sec,gov TO backbone_app,backbone_gov;
GRANT USAGE ON SCHEMA ops TO backbone_gov;
GRANT CREATE ON SCHEMA gov TO backbone_gov;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE backbone_owner,backbone_gov REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE SEQUENCE app.authority_revision;
GRANT USAGE ON SEQUENCE app.authority_revision TO backbone_gov;
CREATE FUNCTION sec.current_workspace() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.workspace_id',true),'')::uuid $$;
CREATE FUNCTION sec.current_principal() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.principal_id',true),'')::uuid $$;
CREATE FUNCTION sec.requested_run() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN current_setting('app.run_id',true)~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    THEN current_setting('app.run_id',true)::uuid END $$;
CREATE FUNCTION sec.token_hash(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(coalesce(p,''),'UTF8')),'hex') $$;
CREATE FUNCTION sec.valid_set_spec(p jsonb) RETURNS bool LANGUAGE sql IMMUTABLE AS $$
  SELECT p='"*"' OR (jsonb_typeof(p)='array' AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(p) x WHERE jsonb_typeof(x)<>'string')) $$;
CREATE FUNCTION sec.set_within(a jsonb,b jsonb) RETURNS bool LANGUAGE sql IMMUTABLE AS $$
  SELECT b='"*"' OR (a<>'"*"' AND b @> a) $$;
CREATE FUNCTION sec.set_covers(p jsonb,k text) RETURNS bool LANGUAGE sql IMMUTABLE AS $$
  SELECT p='"*"' OR p ? k $$;
CREATE FUNCTION sec.refuse(p_reason text,p_code text DEFAULT '42501') RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '%',p_reason USING ERRCODE=p_code; END $$;
-- Tenant-composite storage.
CREATE TABLE app.workspaces(id uuid PRIMARY KEY DEFAULT uuidv7(),name text NOT NULL,
  authority_available bool NOT NULL DEFAULT true);
CREATE TABLE app.people(workspace_id uuid REFERENCES app.workspaces,id uuid DEFAULT uuidv7(),
  name text NOT NULL,status text NOT NULL DEFAULT 'active' CHECK(status IN('active','inactive')),
  PRIMARY KEY(workspace_id,id));
CREATE TABLE app.members(workspace_id uuid,principal_id uuid,
  role text NOT NULL CHECK(role IN('owner','admin','member','guest')),PRIMARY KEY(workspace_id,principal_id),
  FOREIGN KEY(workspace_id,principal_id) REFERENCES app.people);
CREATE TABLE app.planes(workspace_id uuid,id uuid DEFAULT uuidv7(),parent_id uuid,
  name text NOT NULL,path uuid[] NOT NULL,exact_audience bool NOT NULL DEFAULT false,archived bool NOT NULL
    DEFAULT false,PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,parent_id) REFERENCES app.planes);
CREATE TABLE app.readers(workspace_id uuid,id uuid DEFAULT uuidv7(),plane_id uuid NOT NULL,
  person_id uuid NOT NULL,active bool NOT NULL DEFAULT true,PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,plane_id,person_id),
  FOREIGN KEY(workspace_id,plane_id) REFERENCES app.planes,
  FOREIGN KEY(workspace_id,person_id) REFERENCES app.people);
-- Audience revisions follow every membership write, including trusted identity fixtures.
CREATE FUNCTION app.audience_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE app.planes SET version=version WHERE id IN(OLD.plane_id,NEW.plane_id); RETURN NULL;
END $$;
CREATE TRIGGER audience AFTER INSERT OR UPDATE OR DELETE ON app.readers
  FOR EACH ROW EXECUTE FUNCTION app.audience_revision();
CREATE TABLE app.tasks(workspace_id uuid,id uuid DEFAULT uuidv7(),plane_id uuid NOT NULL,
  requested_by uuid NOT NULL,title text NOT NULL,PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,plane_id) REFERENCES app.planes,
  FOREIGN KEY(workspace_id,requested_by) REFERENCES app.people);
CREATE TABLE app.contracts(workspace_id uuid,id uuid DEFAULT uuidv7(),plane_id uuid NOT NULL,
  owner_id uuid NOT NULL,purpose uuid NOT NULL,terms jsonb NOT NULL,
  state text NOT NULL CHECK(state IN('active','suspended','revoked')),checker bool NOT NULL DEFAULT false,
  PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,plane_id,id),
  FOREIGN KEY(workspace_id,plane_id) REFERENCES app.planes,
  FOREIGN KEY(workspace_id,owner_id) REFERENCES app.people,
  FOREIGN KEY(workspace_id,purpose) REFERENCES app.tasks);
CREATE TABLE app.contract_heads(workspace_id uuid,id uuid,current_id uuid NOT NULL,
  history uuid[] NOT NULL DEFAULT '{}',PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,id,current_id) REFERENCES app.contracts(workspace_id,plane_id,id));
CREATE VIEW sec.contracts WITH(security_invoker=true) AS SELECT c.* FROM app.contract_heads h
  JOIN app.contracts c ON c.id=h.current_id;
ALTER VIEW sec.contracts OWNER TO backbone_gov;
CREATE TABLE app.transfers(workspace_id uuid,id uuid DEFAULT uuidv7(),plane_id uuid NOT NULL,
  expected_id uuid NOT NULL,candidate_id uuid NOT NULL,proposer uuid NOT NULL,basis jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,plane_id,expected_id) REFERENCES app.contracts(workspace_id,plane_id,id),
  FOREIGN KEY(workspace_id,plane_id,candidate_id) REFERENCES app.contracts(workspace_id,plane_id,id),
  FOREIGN KEY(workspace_id,proposer) REFERENCES app.people);
CREATE TABLE app.runs(workspace_id uuid,id uuid DEFAULT uuidv7(),task_id uuid NOT NULL,
  plane_id uuid NOT NULL,requester_id uuid NOT NULL,parent_run uuid,parent_fence bigint,lineage_root uuid NOT NULL,
  fence bigint NOT NULL DEFAULT 1,token_hash text NOT NULL,CHECK((parent_run IS NULL)=(parent_fence IS NULL)),
  attributes jsonb NOT NULL DEFAULT '{}',status text NOT NULL DEFAULT 'running' CHECK(status IN('running','finished',
    'cancelled','erased')),
  PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,task_id) REFERENCES app.tasks,
  FOREIGN KEY(workspace_id,plane_id) REFERENCES app.planes,
  FOREIGN KEY(workspace_id,requester_id) REFERENCES app.people,
  FOREIGN KEY(workspace_id,parent_run) REFERENCES app.runs,
  FOREIGN KEY(workspace_id,lineage_root) REFERENCES app.runs);
CREATE TABLE app.executions(workspace_id uuid,id uuid DEFAULT uuidv7(),run_id uuid NOT
  NULL,
  fence bigint NOT NULL,model_id text NOT NULL CHECK(length(model_id)>0),pin text NOT NULL CHECK(pin=model_id),
  family text NOT NULL CHECK(length(family)>0),provider text NOT NULL CHECK(length(provider)>0),
  region text NOT NULL CHECK(length(region)>0),harness text NOT NULL CHECK(length(harness)>0),
  PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,run_id) REFERENCES app.runs);
CREATE TABLE app.checker_planes(workspace_id uuid,id uuid,eligible bool NOT NULL,
  PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,id) REFERENCES app.planes);
CREATE TABLE app.targets(workspace_id uuid,id uuid DEFAULT uuidv7(),task_id uuid NOT NULL,
  plane_id uuid NOT NULL,head uuid,PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,task_id) REFERENCES app.tasks,
  FOREIGN KEY(workspace_id,plane_id) REFERENCES app.planes);
CREATE TABLE app.intents(workspace_id uuid,id uuid DEFAULT uuidv7(),run_id uuid NOT NULL,
  fence bigint NOT NULL,target_id uuid NOT NULL,checker_run uuid NOT NULL,checker_fence bigint NOT NULL,
  makers uuid[] NOT NULL,checkers uuid[] NOT NULL,document bool NOT NULL DEFAULT false,action text NOT NULL DEFAULT
    'promotion',rubric_digest text NOT NULL
    CHECK(rubric_digest~'^[0-9a-f]{64}$'),
  PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,run_id) REFERENCES app.runs,
  FOREIGN KEY(workspace_id,checker_run) REFERENCES app.runs,
  FOREIGN KEY(workspace_id,target_id) REFERENCES app.targets);
CREATE TABLE app.snapshots(workspace_id uuid,id uuid DEFAULT uuidv7(),intent_id uuid NOT
  NULL,
  reservation_id uuid NOT NULL,base_head uuid,base_version bigint NOT NULL,run_id uuid NOT NULL,plane_id uuid NOT NULL,
    payload bytea NOT NULL,
  tree_hash text NOT
  NULL,
  content_sha256 text NOT NULL,manifest_digest text NOT NULL,authority_vector jsonb NOT NULL,expires_at timestamptz
  NOT NULL,
  hot bool NOT NULL,PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,reservation_id),
  FOREIGN KEY(workspace_id,intent_id) REFERENCES app.intents,
  FOREIGN KEY(workspace_id,run_id) REFERENCES app.runs);
CREATE TABLE app.verdicts(workspace_id uuid,id uuid DEFAULT uuidv7(),snapshot_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  checker_run uuid NOT NULL,checker_fence bigint NOT NULL,checkers uuid[] NOT NULL,result text NOT NULL CHECK(result IN(
  'satisfied','needs_revision','max_iterations_reached','failed','interrupted','held')),consumed_at timestamptz,
  deactivated_reason text,PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,snapshot_id),
  FOREIGN KEY(workspace_id,snapshot_id) REFERENCES app.snapshots,
  FOREIGN KEY(workspace_id,intent_id) REFERENCES app.intents,
  FOREIGN KEY(workspace_id,checker_run) REFERENCES app.runs);
CREATE UNIQUE INDEX one_landing_per_intent ON app.verdicts(workspace_id,intent_id) WHERE consumed_at IS NOT NULL;
CREATE TABLE app.artifacts(workspace_id uuid,id uuid,target_id uuid NOT NULL,
  plane_id uuid NOT NULL,files jsonb NOT NULL,PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,id) REFERENCES app.verdicts,
  FOREIGN KEY(workspace_id,target_id) REFERENCES app.targets);
CREATE TABLE app.ledgers(workspace_id uuid PRIMARY KEY REFERENCES app.workspaces,last_seq bigint NOT NULL
  DEFAULT 0,
  last_hash text NOT NULL DEFAULT 'genesis');
CREATE TABLE app.receipts(workspace_id uuid,id uuid DEFAULT uuidv7(),seq bigint NOT NULL,
  receipt jsonb NOT NULL,prev_hash text NOT NULL,hash text NOT NULL,PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,
  seq));
CREATE TABLE app.support_grants(workspace_id uuid,id uuid DEFAULT uuidv7(),plane_id uuid NOT NULL,
  beneficiary uuid NOT NULL,proposer uuid NOT NULL,approver uuid,expires_at timestamptz NOT NULL,ledger_id uuid,
  active bool NOT NULL DEFAULT false,PRIMARY KEY(workspace_id,id),CHECK(approver IS NULL OR approver<>proposer),
  CHECK(NOT active OR (approver IS NOT NULL AND ledger_id IS NOT NULL)),
  FOREIGN KEY(workspace_id,plane_id) REFERENCES app.planes,
  FOREIGN KEY(workspace_id,beneficiary) REFERENCES app.people,
  FOREIGN KEY(workspace_id,proposer) REFERENCES app.people,
  FOREIGN KEY(workspace_id,approver) REFERENCES app.people,
  FOREIGN KEY(workspace_id,ledger_id) REFERENCES app.receipts);
CREATE FUNCTION app.immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM sec.refuse('immutable row','23514'); END $$;
CREATE TRIGGER terminal BEFORE UPDATE OF archived ON app.planes FOR EACH ROW
  WHEN(OLD.archived AND NOT NEW.archived) EXECUTE FUNCTION app.immutable();
CREATE TRIGGER immutable_delete BEFORE DELETE ON app.planes FOR EACH ROW EXECUTE FUNCTION app.immutable();
CREATE FUNCTION app.revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.version:=nextval('app.authority_revision'); RETURN NEW; END $$;
CREATE TABLE ops.transaction_barriers(id xid8 PRIMARY KEY,writing bool NOT NULL);
ALTER TABLE ops.transaction_barriers OWNER TO backbone_owner;
GRANT SELECT,INSERT ON ops.transaction_barriers TO backbone_gov;
CREATE FUNCTION gov._transaction_barrier(p_write bool) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM ops.transaction_barriers WHERE id=pg_current_xact_id() AND writing<>p_write) THEN
    PERFORM sec.refuse('scratch and ledger transactions must be separate','40001'); END IF;
  INSERT INTO ops.transaction_barriers VALUES(pg_current_xact_id(),p_write) ON CONFLICT DO NOTHING;
END $$;
CREATE FUNCTION gov._event(p_type text,p_payload jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE h app.ledgers; v uuid:=uuidv7(); body jsonb; digest text;
BEGIN
  SELECT * INTO STRICT h FROM app.ledgers FOR UPDATE;
  body:=jsonb_build_object('type',p_type,'payload',p_payload,'at',clock_timestamp()::text);
  digest:=encode(sha256(convert_to(h.last_hash||body::text,'UTF8')),'hex');
  INSERT INTO app.receipts(workspace_id,id,seq,receipt,prev_hash,hash)
    VALUES(h.workspace_id,v,h.last_seq+1,body,h.last_hash,digest);
  UPDATE app.ledgers SET last_seq=last_seq+1,last_hash=digest;
  RETURN v;
END $$;
-- Authority: current pointers and post-wait wall time.
CREATE FUNCTION gov._gate() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF sec.current_workspace() IS NULL OR nullif(current_setting('app.app_token',true),'') IS NOT NULL THEN
    PERFORM sec.refuse('workspace product session required');
  END IF;
  PERFORM gov._transaction_barrier(false);
  PERFORM 1 FROM app.ledgers FOR UPDATE;
  IF NOT FOUND THEN PERFORM sec.refuse('workspace missing'); END IF;
END $$;
CREATE FUNCTION sec.person_active(p uuid) RETURNS bool LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT
  EXISTS(SELECT 1 FROM app.people p JOIN app.members m
  ON m.principal_id=p.id WHERE p.id=$1 AND p.status='active' AND m.role<>'guest') $$;
-- Person authentication belongs to the identity role alone: a session minted by the door is the person, absent.
CREATE TABLE ops.person_sessions(workspace_id uuid,person_id uuid NOT NULL,token_hash text,
  expires_at timestamptz NOT NULL,PRIMARY KEY(workspace_id,token_hash));
ALTER TABLE ops.person_sessions OWNER TO backbone_owner;
GRANT SELECT,INSERT ON ops.person_sessions TO backbone_gov;
CREATE FUNCTION sec.authenticated_person() RETURNS uuid LANGUAGE sql SECURITY DEFINER AS $$ SELECT person_id
  FROM ops.person_sessions
  WHERE workspace_id=sec.current_workspace() AND person_id=sec.current_principal() AND
  token_hash=sec.token_hash(current_setting('app.person_token',true)) AND expires_at>clock_timestamp() AND
  sec.person_active(person_id) $$;
CREATE FUNCTION gov.authenticate_person(p_person uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE secret text:=gov._secret();
BEGIN
  PERFORM gov._gate();
  IF current_setting('role',true)<>'planes_identity' THEN PERFORM sec.refuse('identity role required'); END IF;
  IF NOT sec.person_active(p_person) THEN PERFORM sec.refuse('active person required'); END IF;
  INSERT INTO ops.person_sessions VALUES(sec.current_workspace(),p_person,sec.token_hash(secret),
    clock_timestamp()+interval '300 seconds'); RETURN secret;
END $$;
CREATE FUNCTION gov._admin(p uuid) RETURNS bool LANGUAGE sql STABLE AS $$
  SELECT sec.person_active(p) AND EXISTS(SELECT 1 FROM app.members WHERE principal_id=p AND role IN('owner',
  'admin')) $$;
CREATE FUNCTION gov._person(p_admin bool DEFAULT false,p_online bool DEFAULT false,p_fixture bool DEFAULT
  false) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  PERFORM gov._gate();
  IF p_fixture THEN
    IF current_setting('role',true)<>'planes_identity' THEN PERFORM sec.refuse('trusted fixture required'); END IF;
    RETURN (SELECT principal_id FROM app.members WHERE role='owner' ORDER BY principal_id LIMIT 1);
  END IF;
  IF (p_online AND NOT (SELECT authority_available FROM app.workspaces)) OR
    sec.requested_run() IS NOT NULL OR sec.authenticated_person() IS NULL OR
    (p_admin AND NOT gov._admin(sec.current_principal())) THEN
    PERFORM sec.refuse('active person required');
  END IF;
  RETURN sec.current_principal();
END $$;
CREATE FUNCTION sec.contract_within(a jsonb,b jsonb) RETURNS bool LANGUAGE sql IMMUTABLE AS $$ SELECT
  NOT EXISTS(SELECT 1 FROM unnest(ARRAY['data','tools','destinations','models']) k
    WHERE sec.set_within(a->k,b->k) IS NOT TRUE) AND
  (a->>'budget')::numeric<=(b->>'budget')::numeric AND (a->>'ceiling')::int<=(b->>'ceiling')::int $$;
CREATE FUNCTION sec.contract_alive(p_plane uuid) RETURNS bool LANGUAGE sql SECURITY DEFINER AS $$ SELECT
  (SELECT authority_available FROM app.workspaces) AND
  coalesce(bool_and(c.state='active' AND sec.person_active(c.owner_id)
  AND (c.terms->>'expires')::timestamptz>clock_timestamp() AND NOT n.archived AND (n.parent_id IS NULL OR
  sec.contract_within(c.terms,parent.terms))) AND count(c.id)=cardinality(p.path),false)
  FROM app.planes p JOIN app.planes n ON n.id=ANY(p.path) LEFT JOIN sec.contracts c ON c.plane_id=n.id
  LEFT JOIN sec.contracts parent ON parent.plane_id=n.parent_id
  WHERE p.id=p_plane GROUP BY p.path $$;
-- A run is open at one fence while every run above it runs at the fence that admitted the run below: closing a parent
-- ends what it delegated, and so does rotating a parent's suspected-leaked secret. Alive also needs live authority.
CREATE FUNCTION sec.run_open(p uuid,f bigint) RETURNS bool LANGUAGE sql SECURITY DEFINER AS $$ SELECT
  EXISTS(SELECT 1 FROM app.runs r WHERE r.id=p AND r.fence=f AND r.status='running')
  AND NOT EXISTS(WITH RECURSIVE up(id,fence) AS(SELECT parent_run,parent_fence FROM app.runs WHERE id=p
    UNION SELECT r.parent_run,r.parent_fence FROM app.runs r JOIN up ON r.id=up.id)
    SELECT 1 FROM up JOIN app.runs a ON a.id=up.id WHERE a.status<>'running' OR a.fence<>up.fence) $$;
CREATE FUNCTION sec.run_alive(p uuid,f bigint) RETURNS bool LANGUAGE sql SECURITY DEFINER AS $$ SELECT
  sec.run_open(p,f) AND EXISTS(SELECT 1 FROM app.runs r JOIN app.tasks t ON t.id=r.task_id
  WHERE r.id=p AND r.plane_id=t.plane_id AND sec.contract_alive(r.plane_id)) $$;
CREATE FUNCTION sec.current_run() RETURNS uuid LANGUAGE sql SECURITY DEFINER AS $$ SELECT id FROM app.runs
  WHERE id=sec.requested_run() AND
  fence::text=current_setting('app.run_fence',true) AND
  nullif(current_setting('app.app_token',true),'') IS NULL AND
  token_hash=sec.token_hash(current_setting('app.run_token',true)) AND sec.run_alive(id,fence) $$;
CREATE FUNCTION sec.effective_principal() RETURNS uuid LANGUAGE sql SECURITY DEFINER AS $$ SELECT CASE WHEN
  sec.requested_run() IS NULL THEN
  sec.authenticated_person() ELSE
  (SELECT c.owner_id FROM app.runs r JOIN sec.contracts c ON c.plane_id=r.plane_id WHERE r.id=sec.current_run()) END $$;
CREATE FUNCTION sec.plane_visible(p_plane uuid) RETURNS bool LANGUAGE sql SECURITY DEFINER AS $$ SELECT
  sec.contract_alive(p_plane) AND sec.person_sees(p_plane,sec.effective_principal()) $$;
CREATE FUNCTION sec.person_sees(p_plane uuid,p_person uuid) RETURNS bool LANGUAGE sql SECURITY DEFINER AS
  $$ SELECT sec.person_active(p_person) AND EXISTS(
  SELECT 1 FROM app.planes p WHERE p.id=p_plane AND NOT p.archived AND (EXISTS(
    SELECT 1 FROM app.readers m WHERE m.plane_id=ANY(CASE WHEN p.exact_audience THEN ARRAY[p.id] ELSE p.path
      END) AND m.person_id=p_person AND m.active) OR
  EXISTS(
    SELECT 1 FROM app.support_grants s WHERE s.plane_id=ANY(p.path) AND s.beneficiary=p_person AND s.active AND
    s.expires_at>clock_timestamp()))) $$;
CREATE FUNCTION gov.propose_support(p_plane uuid,p_beneficiary uuid,p_until timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE person uuid:=gov._person(); v uuid;
BEGIN
  IF NOT gov._admin(person) OR NOT sec.person_active(p_beneficiary) OR p_until<=clock_timestamp() OR
    p_until>clock_timestamp()+interval '1 hour' THEN
    PERFORM sec.refuse('bounded administrative support grant required'); END IF;
  INSERT INTO app.support_grants(workspace_id,plane_id,beneficiary,proposer,expires_at)
    VALUES(sec.current_workspace(),p_plane,p_beneficiary,person,p_until) RETURNING id INTO v; RETURN v;
END $$;
CREATE FUNCTION gov.approve_support(p_grant uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE person uuid:=gov._person(); s app.support_grants; event uuid;
BEGIN
  SELECT * INTO STRICT s FROM app.support_grants WHERE id=p_grant AND approver IS NULL;
  IF NOT gov._admin(person) OR NOT gov._admin(s.proposer) OR person=s.proposer OR s.expires_at<=clock_timestamp() THEN
    PERFORM sec.refuse('two live independent administrators required'); END IF;
  event:=gov._event('support.approved',jsonb_build_object('grant',s.id,'proposer',s.proposer,'approver',person,
    'beneficiary',s.beneficiary,'expires',s.expires_at::text));
  UPDATE app.support_grants SET approver=person,ledger_id=event WHERE id=s.id;
END $$;
CREATE FUNCTION gov.activate_support(p_grant uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE person uuid:=gov._person(); s app.support_grants;
BEGIN
  SELECT * INTO STRICT s FROM app.support_grants WHERE id=p_grant AND NOT active;
  IF person NOT IN(s.proposer,s.approver) OR s.approver IS NULL OR NOT gov._admin(s.proposer) OR
    NOT gov._admin(s.approver) OR s.expires_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM app.receipts
    WHERE id=s.ledger_id AND receipt->>'type'='support.approved') THEN
    PERFORM sec.refuse('recorded two-party approval required before activation'); END IF;
  UPDATE app.support_grants SET active=true WHERE id=s.id;
  UPDATE app.planes SET version=version WHERE id=s.plane_id;
  PERFORM gov._event('support.activated',jsonb_build_object('grant',s.id));
END $$;
CREATE FUNCTION gov.revoke_support(p_grant uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM gov._person(true);
  UPDATE app.support_grants SET active=false,expires_at=clock_timestamp() WHERE id=p_grant RETURNING id INTO STRICT
  p_grant;
  UPDATE app.planes SET version=version WHERE id=(SELECT plane_id FROM app.support_grants WHERE id=p_grant);
  PERFORM gov._event('support.revoked',jsonb_build_object('grant',p_grant));
END $$;
CREATE FUNCTION app.contract_invariant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text; parent jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN PERFORM sec.refuse('immutable contract','23514'); END IF;
  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.terms) key) IS DISTINCT FROM
    ARRAY['budget','ceiling','data','destinations','expires','models','tools']::text[] OR
    jsonb_typeof(NEW.terms->'budget') IS DISTINCT FROM 'number' OR
    jsonb_typeof(NEW.terms->'ceiling') IS DISTINCT FROM 'number' OR
    jsonb_typeof(NEW.terms->'expires') IS DISTINCT FROM 'string' OR
    ((NEW.terms->>'expires')<>'infinity' AND (NEW.terms->>'expires') !~
      ('^[0-9]{4,6}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
    '([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$')) OR
    (NEW.terms->>'budget')::numeric<0 OR (NEW.terms->>'budget')::numeric%1<>0 OR (NEW.terms->>'ceiling')::int NOT
      BETWEEN 1 AND 4 OR
    NOT EXISTS(SELECT 1 FROM app.tasks WHERE id=NEW.purpose AND plane_id=NEW.plane_id AND length(title)>0) THEN
    PERFORM sec.refuse('closed contract schema and purpose required','23514');
  END IF;
  FOREACH k IN ARRAY ARRAY['data','destinations','models','tools'] LOOP
    IF sec.valid_set_spec(NEW.terms->k) IS NOT TRUE THEN
      PERFORM sec.refuse('decidable set required','23514');
    END IF;
  END LOOP;
  IF NEW.state<>'revoked' AND (EXISTS(SELECT 1 FROM app.planes WHERE id=NEW.plane_id AND archived) OR
    EXISTS(SELECT 1 FROM sec.contracts c WHERE c.plane_id=NEW.plane_id AND c.state='revoked')) THEN
    PERFORM sec.refuse('terminal tombstone','23514');
  END IF;
  IF NEW.state='active' THEN
    SELECT c.terms INTO parent FROM app.planes p JOIN sec.contracts c ON c.plane_id=p.parent_id WHERE
      p.id=NEW.plane_id;
    -- Exact current terms widen nothing: a transfer moves ownership, and liveness still judges use.
    IF NOT sec.person_active(NEW.owner_id) OR (NOT EXISTS(SELECT 1 FROM sec.contracts c WHERE c.plane_id=NEW.plane_id
      AND c.terms=NEW.terms AND c.purpose=NEW.purpose) AND
      EXISTS(SELECT 1 FROM app.planes WHERE id=NEW.plane_id AND parent_id IS NOT NULL AND
      (NOT sec.contract_alive(parent_id) OR sec.contract_within(NEW.terms,parent) IS NOT TRUE))) THEN
      PERFORM sec.refuse('outside current owner or parent envelope','23514');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invariant BEFORE INSERT OR UPDATE OR DELETE ON app.contracts
  FOR EACH ROW EXECUTE FUNCTION app.contract_invariant();
CREATE FUNCTION app.head_invariant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (NEW.workspace_id<>OLD.workspace_id OR NEW.id<>OLD.id OR
    EXISTS(SELECT 1 FROM app.contracts WHERE id=OLD.current_id AND state='revoked'))) THEN
    PERFORM sec.refuse('terminal pointer','23514');
  END IF;
  NEW.history:=CASE WHEN TG_OP='INSERT' THEN ARRAY[NEW.current_id] ELSE OLD.history||NEW.current_id END;
  RETURN NEW;
END $$;
CREATE TRIGGER invariant BEFORE INSERT OR UPDATE OR DELETE ON app.contract_heads FOR EACH ROW EXECUTE FUNCTION
  app.head_invariant();
-- Immutable owners and version-bound recovery.
CREATE FUNCTION gov._append_contract(p_plane uuid,p_owner uuid,p_purpose uuid,p_terms jsonb,p_state text,
  p_checker bool,p_apply bool DEFAULT true) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  INSERT INTO app.contracts(workspace_id,plane_id,owner_id,purpose,terms,state,checker)
    VALUES(sec.current_workspace(),p_plane,p_owner,p_purpose,p_terms,p_state,p_checker) RETURNING id INTO v;
  IF p_apply THEN
    INSERT INTO app.contract_heads(workspace_id,id,current_id) VALUES(sec.current_workspace(),p_plane,v)
      ON CONFLICT(workspace_id,id) DO UPDATE SET current_id=excluded.current_id;
  END IF;
  RETURN v;
END $$;
CREATE FUNCTION gov.set_contract(p_plane uuid,p_purpose uuid,p_terms jsonb,p_checker bool DEFAULT false,
  p_owner uuid DEFAULT NULL,p_ttl float8 DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE person uuid:=gov._person(false,true); old app.contracts; v uuid; parent uuid;
BEGIN
  SELECT c.* INTO old FROM sec.contracts c WHERE c.plane_id=p_plane;
  SELECT c.owner_id INTO parent FROM app.planes p JOIN sec.contracts c ON c.plane_id=p.parent_id WHERE
    p.id=p_plane;
  p_owner:=coalesce(p_owner,person);
  IF (old.id IS NULL AND NOT (CASE WHEN parent IS NULL THEN gov._admin(person) ELSE parent=person END)) OR (old.id IS
    NOT NULL AND
    (old.owner_id<>person OR old.owner_id<>p_owner OR old.state<>'active')) OR
    (p_checker AND NOT gov._admin(person)) THEN PERFORM sec.refuse('contract owner/admin required'); END IF;
  IF p_ttl IS NOT NULL THEN
    IF NOT (p_ttl>0 AND p_ttl<>'NaN'::float8) THEN PERFORM sec.refuse('positive lifetime','23514'); END IF;
    p_terms:=jsonb_set(p_terms,'{expires}',CASE WHEN p_ttl='Infinity'::float8 THEN '"infinity"'::jsonb
      ELSE to_jsonb(clock_timestamp()+p_ttl*interval '1 millisecond') END);
  END IF;
  v:=gov._append_contract(p_plane,p_owner,p_purpose,p_terms,'active',p_checker);
  PERFORM gov._event('contract.replaced',jsonb_build_object('plane',p_plane,'contract',v)); RETURN v;
END $$;
CREATE FUNCTION gov.revoke_contract(p_plane uuid,p_fixture bool DEFAULT false) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE person uuid:=gov._person(false,false,p_fixture); c app.contracts; v uuid;
BEGIN
  SELECT cv.* INTO c FROM app.planes p LEFT JOIN sec.contracts cv ON cv.plane_id=p.id WHERE p.id=p_plane;
  IF NOT FOUND THEN PERFORM sec.refuse('plane missing','P0002'); END IF;
  IF p_fixture IS NOT TRUE AND c.owner_id IS DISTINCT FROM person AND NOT gov._admin(person) THEN
    PERFORM sec.refuse('owner required'); END IF;
  UPDATE app.planes SET archived=true WHERE id=p_plane AND NOT archived;
  IF NOT FOUND THEN RETURN c.id; END IF;
  IF c.id IS NOT NULL THEN
    v:=gov._append_contract(c.plane_id,c.owner_id,c.purpose,c.terms,'revoked',c.checker);
  END IF;
  PERFORM gov._invalidate();
  PERFORM gov._event('contract.revoked',jsonb_build_object('plane',p_plane,'contract',v)); RETURN v;
END $$;
CREATE FUNCTION gov._recovery_authority(p_plane uuid,p_person uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT CASE WHEN sec.person_active(p_person) AND CASE WHEN sec.person_active(c.owner_id) AND c.state='active'
    THEN c.owner_id=p_person WHEN p.parent_id IS NULL THEN gov._admin(p_person) ELSE
    pc.owner_id=p_person AND pc.state<>'suspended' AND sec.person_active(pc.owner_id) END
  THEN jsonb_build_array(a.version::text,CASE WHEN sec.person_active(c.owner_id) AND c.state='active'
    THEN NULL ELSE ph.version::text END) END FROM sec.contracts c JOIN app.planes p ON p.id=c.plane_id
    JOIN app.people a ON a.id=p_person LEFT JOIN sec.contracts pc ON pc.plane_id=p.parent_id
    LEFT JOIN app.contract_heads ph ON ph.id=p.parent_id WHERE c.plane_id=p_plane $$;
CREATE FUNCTION gov.propose_contract_recovery(p_plane uuid,p_owner uuid,p_purpose uuid,p_terms jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE person uuid:=gov._person(false,true); old app.contracts; v uuid; change uuid;
BEGIN
  SELECT c.* INTO STRICT old FROM sec.contracts c WHERE
  c.plane_id=p_plane;
  IF p_purpose IS DISTINCT FROM old.purpose OR p_terms IS DISTINCT FROM old.terms THEN
    PERFORM sec.refuse('transfer preserves purpose and exact terms','23514'); END IF;
  IF person=p_owner OR gov._recovery_authority(p_plane,person) IS NULL THEN
    PERFORM sec.refuse('independent recovery authority required'); END IF;
  v:=gov._append_contract(p_plane,p_owner,p_purpose,p_terms,'active',old.checker,false);
  INSERT INTO app.transfers(workspace_id,plane_id,expected_id,candidate_id,proposer,basis,expires_at)
    VALUES(old.workspace_id,p_plane,old.id,v,person,gov._recovery_authority(p_plane,person),clock_timestamp()+interval
      '5 minutes') RETURNING id INTO change;
  PERFORM gov._event('contract.recovery_proposed',jsonb_build_object('change',change)); RETURN change;
END $$;
CREATE FUNCTION gov.accept_contract_recovery(p_change uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE person uuid:=gov._person(false,true); ch app.transfers; c app.contracts;
BEGIN
  SELECT * INTO STRICT ch FROM app.transfers WHERE id=p_change;
  SELECT * INTO STRICT c FROM app.contracts WHERE id=ch.candidate_id;
  IF person<>c.owner_id OR person=ch.proposer OR ch.expires_at<=clock_timestamp() OR
    ch.basis IS DISTINCT FROM gov._recovery_authority(ch.plane_id,ch.proposer) OR
    NOT EXISTS(SELECT 1 FROM app.contract_heads WHERE id=ch.plane_id AND current_id=ch.expected_id) THEN
    PERFORM sec.refuse('two fresh parties required'); END IF;
  UPDATE app.contract_heads SET current_id=c.id WHERE id=ch.plane_id;
  INSERT INTO app.readers(workspace_id,plane_id,person_id)
    SELECT c.workspace_id,ch.plane_id,person FROM app.planes WHERE id=ch.plane_id AND NOT exact_audience
    ON CONFLICT(workspace_id,plane_id,person_id) DO UPDATE SET active=true;
  PERFORM gov._event('contract.recovered',jsonb_build_object('change',p_change)); RETURN c.id;
END $$;
CREATE FUNCTION app.suspend_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c app.contracts; person uuid;
BEGIN
  PERFORM gov._gate();
  IF TG_TABLE_NAME='people' THEN person:=NEW.id; ELSE person:=OLD.principal_id; END IF;
  UPDATE app.planes SET version=version WHERE id IN(SELECT plane_id FROM app.readers
    WHERE person_id=person AND active);
  IF TG_TABLE_NAME='people' THEN IF NEW.status='active' THEN RETURN NULL; END IF; END IF;
  FOR c IN SELECT cv.* FROM sec.contracts cv
    WHERE cv.owner_id=person AND cv.state<>'revoked' LOOP
    PERFORM gov._append_contract(c.plane_id,c.owner_id,c.purpose,c.terms,'suspended',c.checker);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER suspend AFTER UPDATE OF status ON app.people FOR EACH ROW
  WHEN(OLD.status<>NEW.status) EXECUTE FUNCTION app.suspend_owner();
CREATE TRIGGER suspend AFTER DELETE ON app.members FOR EACH ROW EXECUTE FUNCTION app.suspend_owner();
CREATE TRIGGER suspend_role AFTER UPDATE OF role ON app.members FOR EACH ROW
  WHEN(NEW.role='guest' AND OLD.role<>'guest') EXECUTE FUNCTION app.suspend_owner();
-- Handles and door-observed executions.
CREATE FUNCTION gov.admit_run(p_plane uuid,p_task uuid,p_attributes jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql
  SECURITY DEFINER AS $$
DECLARE person uuid; parent app.runs; c app.contracts; v uuid:=uuidv7(); secret text:=gov._secret(); root uuid;
BEGIN
  PERFORM gov._gate();
  SELECT cv.* INTO STRICT c FROM sec.contracts cv WHERE
  cv.plane_id=p_plane;
  IF sec.requested_run() IS NULL THEN
    person:=gov._person();
    IF person<>c.owner_id THEN PERFORM sec.refuse('owner admission required'); END IF;
    root:=v;
  ELSE
    SELECT * INTO parent FROM app.runs WHERE id=sec.current_run();
    IF parent.id IS NULL OR parent.plane_id<>p_plane THEN
      PERFORM sec.refuse('parent admission outside contract'); END IF;
    root:=parent.lineage_root; person:=parent.requester_id;
  END IF;
  IF NOT sec.contract_alive(p_plane) OR NOT EXISTS(SELECT 1 FROM app.tasks WHERE id=p_task AND plane_id=p_plane)
    THEN PERFORM sec.refuse('live contract and task in its plane required');
  END IF;
  INSERT INTO app.runs(workspace_id,id,task_id,plane_id,requester_id,parent_run,parent_fence,lineage_root,token_hash,
    attributes) VALUES(c.workspace_id,v,p_task,p_plane,person,parent.id,parent.fence,root,sec.token_hash(secret),
    p_attributes);
  PERFORM gov._event('run.admitted',jsonb_build_object('run',v,'lineageRoot',root));
  RETURN jsonb_build_object('runId',v,'fence',1,'secret',secret,'lineageRoot',root);
END $$;
CREATE FUNCTION gov.control_run(p_run uuid,p_operation text,p_fixture bool DEFAULT false) RETURNS jsonb LANGUAGE
  plpgsql SECURITY DEFINER AS $$
DECLARE person uuid:=gov._person(false,false,p_fixture); r app.runs; secret text:=gov._secret();
BEGIN
  SELECT * INTO STRICT r FROM app.runs WHERE id=p_run FOR UPDATE;
  IF (p_fixture IS NOT TRUE AND NOT EXISTS(SELECT 1 FROM sec.contracts c
    WHERE c.plane_id=r.plane_id AND c.owner_id=person)) OR p_operation NOT IN('reclaim','cancel','erase') OR
    (r.status<>'running' AND NOT (r.status IN('finished','cancelled') AND p_operation='erase')) OR
    (p_operation='reclaim' AND NOT sec.run_alive(r.id,r.fence)) THEN
    PERFORM sec.refuse('owner control of a live handle required'); END IF;
  UPDATE app.runs SET fence=fence+1,token_hash=sec.token_hash(secret),status=CASE p_operation
    WHEN 'erase' THEN 'erased' WHEN 'cancel' THEN 'cancelled' ELSE status END WHERE id=r.id RETURNING * INTO r;
  IF p_operation='erase' THEN PERFORM gov._erase(r.id); END IF;
  IF p_operation<>'reclaim' THEN PERFORM gov._end_attempts(r.id); END IF;
  PERFORM gov._event('run.'||p_operation,jsonb_build_object('run',r.id,'fence',r.fence::text));
  RETURN jsonb_build_object('runId',r.id,'fence',r.fence,'secret',secret,'lineageRoot',r.lineage_root);
END $$;
CREATE FUNCTION gov.observe_execution(p_run uuid,p_fence bigint,p_model text,p_pin text,p_family text,
  p_provider text,p_region text,p_harness text) RETURNS uuid LANGUAGE plpgsql SECURITY
    DEFINER AS $$
DECLARE v uuid;
BEGIN
  PERFORM gov._gate();
  IF NOT sec.run_alive(p_run,p_fence) OR
    NOT EXISTS(SELECT 1 FROM app.runs r JOIN sec.contracts c ON c.plane_id=r.plane_id WHERE r.id=p_run AND
      sec.set_covers(c.terms->'models',p_model))
  THEN
    PERFORM sec.refuse('observed model outside envelope'); END IF;
  INSERT INTO app.executions(workspace_id,run_id,fence,model_id,pin,family,provider,region,harness)
    VALUES(sec.current_workspace(),p_run,p_fence,p_model,p_pin,p_family,p_provider,p_region,p_harness) RETURNING id
  INTO v;
  RETURN v;
END $$;
-- The full-handle overload never selects the trusted observer's secret-free operation on omission.
CREATE FUNCTION gov.observe_execution(p_run uuid,p_fence bigint,p_model text,p_pin text,p_family text,
  p_provider text,p_region text,p_harness text,p_secret text) RETURNS uuid LANGUAGE plpgsql STRICT SECURITY DEFINER AS
    $$
BEGIN
  PERFORM gov._gate();
  IF sec.current_run() IS DISTINCT FROM p_run OR p_secret IS DISTINCT FROM current_setting('app.run_token',true)
    THEN PERFORM sec.refuse('full run handle required'); END IF;
  RETURN gov.observe_execution(p_run,p_fence,p_model,p_pin,p_family,p_provider,p_region,p_harness);
END $$;
CREATE FUNCTION gov.register_checker(p_plane uuid,p_eligible bool) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  AS $$
DECLARE person uuid:=gov._person(false,true);
BEGIN
  IF NOT EXISTS(SELECT 1 FROM sec.contracts c
    WHERE c.plane_id=p_plane AND c.checker AND c.owner_id=person AND c.state='active') THEN
    PERFORM sec.refuse('checker owner required'); END IF;
  INSERT INTO app.checker_planes(workspace_id,id,eligible) VALUES(sec.current_workspace(),p_plane,p_eligible)
    ON CONFLICT(workspace_id,id) DO UPDATE SET eligible=excluded.eligible;
  PERFORM gov._event('checker.registered',jsonb_build_object('plane',p_plane,'eligible',p_eligible));
END $$;
CREATE FUNCTION gov._executions(p_run uuid,p_document bool DEFAULT false) RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT
  coalesce(array_agg(id ORDER BY id),'{}') FROM app.executions
  WHERE (p_document AND run_id=p_run) OR (NOT p_document AND run_id IN(SELECT id FROM app.runs
    WHERE lineage_root=(SELECT lineage_root FROM app.runs WHERE id=p_run))) $$;
-- The door supplies operations, never caller caps.
CREATE FUNCTION gov.effect_cap(p_run uuid,p_fence bigint,p_tool text,p_operation text) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE cap numeric;
BEGIN
  PERFORM gov._gate();
  IF NOT sec.run_alive(p_run,p_fence) THEN PERFORM sec.refuse('live run required'); END IF;
  SELECT CASE WHEN bool_and(sec.set_covers(c.terms->'tools',p_tool) AND
    sec.set_covers(c.terms->'destinations',p_operation)) THEN min((c.terms->>'budget')::numeric) END INTO cap
    FROM app.runs r JOIN app.planes p ON p.id=r.plane_id JOIN sec.contracts c ON c.plane_id=ANY(p.path) WHERE
      r.id=p_run;
  IF cap IS NULL THEN PERFORM sec.refuse('operation outside contract'); END IF;
  RETURN cap;
END $$;
CREATE FUNCTION gov._independent(m uuid[],c uuid[]) RETURNS bool LANGUAGE sql STABLE AS $$ SELECT cardinality(m)>0
  AND cardinality(c)>0 AND NOT EXISTS(
  SELECT 1 FROM app.executions me JOIN app.runs mr ON mr.id=me.run_id CROSS JOIN
  app.executions ce JOIN app.runs cr ON cr.id=ce.run_id WHERE me.id=ANY(m) AND ce.id=ANY(c) AND
  (mr.lineage_root=cr.lineage_root OR me.family=ce.family OR me.provider=ce.provider)) $$;
-- Immutable crossing input closure.
CREATE FUNCTION gov.create_promotion_target(p_task uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE person uuid:=gov._person(); t app.tasks; v uuid;
BEGIN
  SELECT * INTO STRICT t FROM app.tasks WHERE id=p_task AND requested_by=person;
  IF NOT sec.plane_visible(t.plane_id) THEN PERFORM sec.refuse('target audience required'); END IF;
  INSERT INTO app.targets(workspace_id,task_id,plane_id) VALUES(t.workspace_id,t.id,t.plane_id) RETURNING
  id INTO v;
  RETURN v;
END $$;
CREATE FUNCTION gov.create_promotion_intent(p_target uuid,p_checker uuid,p_rubric text,p_execution uuid DEFAULT NULL,
  p_action text DEFAULT 'promotion') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r app.runs; checker app.runs; target app.targets; v uuid; m uuid[]; c uuid[];
BEGIN
  PERFORM gov._gate();
  SELECT * INTO STRICT r FROM app.runs WHERE id=sec.current_run();
  SELECT * INTO STRICT checker FROM app.runs WHERE id=p_checker AND sec.run_alive(id,fence);
  SELECT * INTO STRICT target FROM app.targets WHERE id=p_target;
  m:=gov._executions(r.id,p_execution IS NOT NULL); c:=gov._executions(checker.id,p_execution IS NOT NULL);
  IF (p_execution IS NOT NULL AND NOT p_execution=ANY(m)) OR NOT gov._independent(m,c) OR
    NOT EXISTS(SELECT 1 FROM app.planes WHERE id=r.plane_id AND target.plane_id=ANY(path)) OR
    (target.plane_id<>r.plane_id AND NOT sec.plane_visible(target.plane_id)) OR NOT EXISTS(
    SELECT 1 FROM app.checker_planes e JOIN sec.contracts cv ON cv.plane_id=e.id WHERE e.id=checker.plane_id AND
      e.eligible AND cv.checker) THEN
    PERFORM sec.refuse('independent eligible checker and audience required'); END IF;
  INSERT INTO app.intents(workspace_id,run_id,fence,target_id,checker_run,checker_fence,makers,
    checkers,rubric_digest,action,document) VALUES(r.workspace_id,r.id,r.fence,target.id,checker.id,checker.fence,m,c,
  p_rubric,p_action,p_execution IS NOT NULL)
    RETURNING id INTO v; RETURN v;
END $$;
CREATE FUNCTION gov._vector(p_intent uuid) RETURNS jsonb LANGUAGE sql AS $$ WITH i AS(SELECT * FROM
  app.intents WHERE id=p_intent),
  r AS(SELECT r.* FROM app.runs r JOIN i ON r.id IN(i.run_id,i.checker_run)),
  planes AS(SELECT p.* FROM app.planes p WHERE p.id IN(SELECT unnest(p.path) FROM app.planes p
    WHERE p.id IN(SELECT plane_id FROM r UNION SELECT t.plane_id FROM app.targets t JOIN i ON
  t.id=i.target_id))),
  v AS(SELECT 'runs' AS t,id AS k,version AS v FROM r UNION ALL SELECT 'contract_heads',h.id,h.version
    FROM app.contract_heads h JOIN planes p ON p.id=h.id
    UNION ALL SELECT 'planes',id,version FROM planes WHERE id IN(SELECT unnest(
      CASE WHEN p.exact_audience THEN ARRAY[p.id] ELSE p.path END) FROM app.planes p
      JOIN app.targets t ON t.plane_id=p.id JOIN i ON t.id=i.target_id)
    UNION ALL SELECT 'tasks',id,version FROM app.tasks WHERE id IN(SELECT task_id FROM r UNION
    SELECT t.task_id FROM app.targets t JOIN i ON t.id=i.target_id)
    UNION ALL SELECT 'checker_planes',e.id,e.version FROM app.checker_planes e JOIN r ON r.plane_id=e.id)
  SELECT jsonb_build_object('core',(SELECT jsonb_agg(jsonb_build_array(t,k,v::text) ORDER BY t,k) FROM v),
    'contracts',(SELECT jsonb_agg(jsonb_build_array(h.id,h.current_id) ORDER BY h.id)
    FROM app.contract_heads h JOIN planes p ON p.id=h.id),
    'target',(SELECT to_jsonb(t)-ARRAY['head','version'] FROM app.targets t JOIN i ON t.id=i.target_id),
    'services',gov._configuration(p_intent)) $$;
CREATE FUNCTION gov._live(p_intent uuid) RETURNS bool LANGUAGE sql AS $$
  SELECT sec.run_alive(r.id,i.fence) AND sec.run_alive(c.id,i.checker_fence) AND
    (t.plane_id=r.plane_id OR sec.person_sees(t.plane_id,mc.owner_id)) AND (t.plane_id=r.plane_id OR
      sec.contract_alive(t.plane_id)) AND
    e.eligible AND cv.checker AND
    gov._independent(i.makers,i.checkers) AND NOT gov._target_unknown(i.target_id)
    FROM app.intents i JOIN app.runs r ON r.id=i.run_id
    JOIN app.runs c ON c.id=i.checker_run JOIN app.targets t ON t.id=i.target_id
    JOIN sec.contracts mc ON mc.plane_id=r.plane_id
    JOIN app.checker_planes e ON e.id=c.plane_id JOIN sec.contracts cv ON cv.plane_id=c.plane_id WHERE
      i.id=p_intent $$;
-- Enforcer changes require two owners.
CREATE FUNCTION gov._hot(p_files jsonb) RETURNS bool LANGUAGE sql IMMUTABLE AS $$
  SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(p_files) f WHERE lower(f->>'path')~
  '(^|/)(test|tests|spec|polic(y|ies)|monitors?|alerts?|alert.routes|degraded.mode|migrations|scripts|'
  '[.]agents|[.]codex|[.]claude|[.]vscode|[.]github|[.]mcp|__tests__|hooks)(/|[._-]|$)|'
  '[.](test|spec)[.][^/]+$|'
  '(^|/)(crossing|policy|monitor|alert|degraded)[^/]*[.](ts|js|sql|json)$|'
  '(^|/)(package[.]json|agents[.]md|claude[.]md|makefile)$') $$;
CREATE FUNCTION gov.record_verdict(p_snapshot uuid,p_result text,p_iteration int,p_defer_policy bool DEFAULT
  false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE s app.snapshots; i app.intents; v uuid; decision text; held jsonb:='{}';
  result text:=CASE WHEN p_result IN('satisfied','needs_revision','max_iterations_reached','failed','interrupted')
    THEN p_result ELSE 'needs_revision' END;
BEGIN
  PERFORM gov._gate();
  SELECT * INTO STRICT s FROM app.snapshots WHERE id=p_snapshot;
  SELECT * INTO STRICT i FROM app.intents WHERE id=s.intent_id;
  IF sec.current_run() IS DISTINCT FROM i.checker_run OR p_iteration<1 OR
    EXISTS(SELECT 1 FROM app.runs WHERE id=i.run_id AND status='erased') OR NOT EXISTS(SELECT 1 FROM app.runs c JOIN
      app.checker_planes e ON e.id=c.plane_id JOIN sec.contracts cv ON cv.plane_id=c.plane_id WHERE c.id=i.checker_run
      AND e.eligible AND cv.checker) OR
    NOT gov._independent(i.makers,gov._executions(i.checker_run,i.document)) OR
    (NOT i.document AND gov._executions(i.checker_run) IS DISTINCT FROM i.checkers) THEN
    PERFORM sec.refuse('authenticated exact checker executions required'); END IF;
  IF s.hot OR NOT coalesce(gov._live(i.id),false) OR s.authority_vector IS DISTINCT FROM gov._vector(i.id) OR
    s.expires_at<=clock_timestamp() THEN result:='needs_revision';
  ELSIF result='satisfied' AND NOT p_defer_policy THEN
    decision:=gov._pack_result(i.id);
    IF decision='deny' THEN result:='needs_revision'; ELSIF decision='hold' THEN result:='held'; END IF;
  END IF;
  INSERT INTO app.verdicts(workspace_id,snapshot_id,intent_id,checker_run,checker_fence,checkers,result)
    SELECT s.workspace_id,s.id,i.id,i.checker_run,fence,gov._executions(i.checker_run,i.document),result
    FROM app.runs WHERE id=i.checker_run RETURNING id INTO v;
  IF p_result<>'satisfied' THEN PERFORM gov._release(s.reservation_id,
    CASE result WHEN 'interrupted' THEN 'interrupted' ELSE 'judged' END); END IF;
  IF result='held' THEN held:=gov._hold(v,s.id); END IF;
  RETURN jsonb_build_object('verdictId',v,'attemptId',v,'result',result,'route',CASE
    result WHEN 'satisfied' THEN 'admit' WHEN 'held' THEN 'human'
    WHEN 'max_iterations_reached' THEN 'human' WHEN 'failed' THEN 'intent_author'
    WHEN 'interrupted' THEN 'none' ELSE 'maker' END)||held;
END $$;
-- Caller-bound attempts; atomic spend/head/artifact/receipt.
CREATE FUNCTION gov.land(p_verdict text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v app.verdicts; s app.snapshots; i app.intents; r app.runs; files jsonb;
  why text:='not_found'; outcome text:='denied-not-executed'; answer jsonb; presented text; decision text;
  held jsonb:='{}';
BEGIN
  PERFORM gov._gate();
  presented:=current_setting('app.run_fence',true);
  SELECT * INTO v FROM app.verdicts WHERE id::text=p_verdict;
  SELECT * INTO s FROM app.snapshots WHERE id=v.snapshot_id;
  SELECT * INTO i FROM app.intents WHERE id=s.intent_id;
  SELECT * INTO r FROM app.runs WHERE id=i.run_id FOR UPDATE;
  IF v.id IS NOT NULL THEN
    why:=CASE WHEN sec.current_run() IS DISTINCT FROM i.run_id OR presented IS DISTINCT FROM i.fence::text
      THEN 'wrong_holder' WHEN EXISTS(SELECT 1 FROM app.verdicts WHERE intent_id=i.id AND consumed_at IS NOT NULL)
      THEN 'already_spent'
      WHEN v.result<>'satisfied' OR v.deactivated_reason IS NOT NULL THEN 'verdict_refused'
      WHEN gov._target_unknown(i.target_id) THEN 'target_unknown'
      WHEN NOT sec.run_alive(v.checker_run,v.checker_fence) THEN 'checker_reclaimed'
      WHEN gov._live(i.id) IS NOT TRUE THEN 'stale_authority'
      WHEN s.authority_vector IS DISTINCT FROM gov._vector(i.id) THEN 'stale_inputs'
      WHEN s.expires_at<=clock_timestamp() OR NOT gov._reservation_live(s.reservation_id) THEN 'expired'
      WHEN NOT EXISTS(SELECT 1 FROM app.targets WHERE id=i.target_id AND version=s.base_version
        AND head IS NOT DISTINCT FROM
  s.base_head)
      THEN 'head_moved'
      WHEN EXISTS(SELECT 1 FROM app.planes p JOIN sec.contracts c ON c.plane_id=ANY(p.path) WHERE p.id=r.plane_id
        AND
        NOT sec.set_covers(c.terms->'destinations',i.action)) THEN 'action_outside_contract'
      WHEN EXISTS(SELECT 1 FROM app.planes p JOIN sec.contracts c ON c.plane_id=ANY(p.path) WHERE p.id=r.plane_id
        AND
        (c.terms->>'budget')::numeric<=(SELECT count(*) FROM app.verdicts x JOIN app.intents y
          ON y.id=x.intent_id JOIN app.runs z ON z.id=y.run_id JOIN app.planes q ON q.id=z.plane_id
          WHERE x.consumed_at IS NOT NULL AND c.plane_id=ANY(q.path))) THEN 'budget_exhausted'
      ELSE 'ready' END;
    IF why='ready' THEN
      files:=gov._snapshot_files(s.id);
      decision:=gov._pack_result(i.id);
      IF decision<>'allow' THEN
        why:=CASE decision WHEN 'deny' THEN 'pack_denied' ELSE 'held' END;
        IF decision='hold' THEN
          outcome:='held-not-executed'; held:=gov._hold(v.id,s.id);
          UPDATE app.verdicts SET deactivated_reason='held' WHERE id=v.id;
        END IF;
      ELSE
        UPDATE app.verdicts SET consumed_at=clock_timestamp() WHERE id=v.id AND consumed_at IS NULL;
        UPDATE app.targets SET head=v.id WHERE id=i.target_id;
        INSERT INTO app.artifacts(workspace_id,id,target_id,plane_id,files)
          SELECT s.workspace_id,v.id,i.target_id,plane_id,files FROM app.targets WHERE id=i.target_id;
        why:='consumed_now'; outcome:='approved-executed';
      END IF;
    END IF;
    IF sec.requested_run()=i.run_id AND r.fence::text=presented AND
      r.token_hash=sec.token_hash(current_setting('app.run_token',true)) THEN PERFORM gov._release(s.reservation_id,
        why); END IF;
  END IF;
  answer:=jsonb_build_object('attemptId',uuidv7(),'verdictId',p_verdict,'runId',current_setting('app.run_id',true),
    'fence',presented,
    'planeId',CASE WHEN gov._key(s.run_id) IS NOT NULL THEN s.plane_id END,'outcome',outcome,'reason',why,'actor_kind',
      'agent','requester',r.requester_id,
    'lineageRoot',r.lineage_root,'contractVector',s.authority_vector,'makers',i.makers,'checkers',v.checkers,
    'snapshotId',s.id,'manifestDigest',s.manifest_digest)||held;
  -- A wrong holder learns it was refused, not whose work this was.
  IF why='wrong_holder' AND r.token_hash IS DISTINCT FROM sec.token_hash(current_setting('app.run_token',true)) THEN
    answer:=answer-ARRAY['requester','lineageRoot','contractVector','makers','checkers',
    'snapshotId','manifestDigest']; END IF;
  PERFORM gov._event('release.'||CASE outcome WHEN 'approved-executed' THEN 'landed'
    WHEN 'held-not-executed' THEN 'held' ELSE 'denied' END,answer);
  RETURN answer;
END $$;
CREATE FUNCTION app.verdict_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['consumed_at','deactivated_reason']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['consumed_at','deactivated_reason']) OR OLD.consumed_at IS NOT NULL THEN
    PERFORM sec.refuse('immutable verdict binding/spend','23514'); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable BEFORE UPDATE ON app.verdicts FOR EACH ROW EXECUTE FUNCTION app.verdict_immutable();
-- Invalidate both sides and descendants.
CREATE FUNCTION app.invalidate_crossings() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM gov._invalidate(); RETURN NULL;
END $$;
CREATE TRIGGER invalidate AFTER UPDATE OF fence,status ON app.runs FOR EACH ROW
  EXECUTE FUNCTION app.invalidate_crossings();
CREATE TRIGGER invalidate AFTER INSERT OR UPDATE ON app.contract_heads FOR EACH ROW
  EXECUTE FUNCTION app.invalidate_crossings();
CREATE TRIGGER invalidate AFTER INSERT OR UPDATE ON app.checker_planes FOR EACH ROW
  EXECUTE FUNCTION app.invalidate_crossings();
-- Void stale verdicts.
CREATE FUNCTION gov._void_verdicts() RETURNS void LANGUAGE sql AS $$
  UPDATE app.verdicts v SET deactivated_reason='stale_authority' FROM app.snapshots s
    WHERE v.snapshot_id=s.id AND v.consumed_at IS NULL AND v.deactivated_reason IS NULL AND
    gov._live(s.intent_id) IS NOT TRUE;
$$;
-- Person administration.
CREATE FUNCTION gov.add_person(p_name text,p_role text DEFAULT 'member',p_fixture bool DEFAULT false) RETURNS uuid
  LANGUAGE plpgsql SECURITY
  DEFINER AS $$
DECLARE person uuid:=gov._person(true,false,p_fixture); v uuid;
BEGIN
  INSERT INTO app.people(workspace_id,name) VALUES(sec.current_workspace(),p_name) RETURNING id INTO v;
  INSERT INTO app.members(workspace_id,principal_id,role) VALUES(sec.current_workspace(),v,p_role);
  PERFORM gov._event('person.added',jsonb_build_object('person',v,'role',p_role)); RETURN v;
END $$;
CREATE FUNCTION gov.deactivate_principal(p_person uuid,p_fixture bool DEFAULT false) RETURNS void LANGUAGE plpgsql
  SECURITY DEFINER AS $$
DECLARE person uuid:=gov._person(true,false,p_fixture);
BEGIN
  UPDATE app.people SET status='inactive' WHERE id=p_person AND status='active';
  IF NOT FOUND THEN
    IF NOT EXISTS(SELECT 1 FROM app.people WHERE id=p_person) THEN
      PERFORM sec.refuse('person missing','P0002'); END IF;
    RETURN;
  END IF;
  PERFORM gov._event('person.deactivated',jsonb_build_object('person',p_person));
END $$;
CREATE FUNCTION gov.create_plane(p_name text,p_parent uuid DEFAULT NULL,p_readers uuid[] DEFAULT NULL,p_fixture bool
  DEFAULT false) RETURNS uuid LANGUAGE plpgsql SECURITY
  DEFINER AS $$
DECLARE person uuid:=gov._person(true,false,p_fixture); v uuid:=uuidv7(); path uuid[]:='{}';
BEGIN
  IF p_parent IS NOT NULL THEN SELECT p.path INTO STRICT path FROM app.planes p WHERE p.id=p_parent; END IF;
  INSERT INTO app.planes(workspace_id,id,parent_id,name,path,exact_audience)
    VALUES(sec.current_workspace(),v,p_parent,p_name,path||v,p_readers IS NOT NULL);
  INSERT INTO app.readers(workspace_id,plane_id,person_id)
    SELECT sec.current_workspace(),v,x FROM unnest(coalesce(p_readers,ARRAY[person])) x;
  PERFORM gov._event('plane.created',jsonb_build_object('plane',v)); RETURN v;
END $$;
CREATE FUNCTION gov.set_plane_member(p_plane uuid,p_person uuid,p_active bool,p_fixture bool DEFAULT false)
  RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE person uuid:=gov._person(true,false,p_fixture);
BEGIN
  IF (p_active AND NOT sec.person_active(p_person)) OR p_active=EXISTS(SELECT 1 FROM app.readers
    WHERE plane_id=p_plane AND person_id=p_person AND active) THEN PERFORM sec.refuse('membership unchanged'); END IF;
  INSERT INTO app.readers(workspace_id,plane_id,person_id,active)
    VALUES(sec.current_workspace(),p_plane,p_person,p_active) ON CONFLICT(workspace_id,plane_id,person_id)
    DO UPDATE SET active=excluded.active;
  PERFORM gov._invalidate();
  PERFORM gov._event('plane.membership',jsonb_build_object('plane',p_plane,'person',p_person,'active',p_active));
END $$;
CREATE FUNCTION gov.create_task(p_plane uuid,p_title text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE person uuid:=gov._person(); v uuid;
BEGIN
  IF NOT (sec.person_sees(p_plane,person) OR gov._admin(person) OR EXISTS(SELECT 1 FROM app.planes p
    JOIN sec.contracts c ON c.plane_id IN(p.id,p.parent_id)
    WHERE p.id=p_plane AND c.owner_id=person)) THEN PERFORM sec.refuse('plane audience/owner required'); END IF;
  INSERT INTO app.tasks(workspace_id,plane_id,requested_by,title) VALUES(sec.current_workspace(),p_plane,person,p_title)
    RETURNING id INTO v; RETURN v;
END $$;
-- In-plane run/scratch locking.
CREATE FUNCTION gov._open_scratch() RETURNS TABLE(workspace_id uuid,run_id uuid,fence bigint,head_hash text,head_seq
  int)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r app.runs;
BEGIN
  SELECT * INTO STRICT r FROM app.runs WHERE id=sec.requested_run() FOR SHARE;
  IF sec.current_run() IS DISTINCT FROM r.id THEN PERFORM sec.refuse('live fenced handle required'); END IF;
  RETURN QUERY SELECT s.workspace_id,s.run_id,r.fence,s.head_hash,s.head_seq FROM app.scratch_spaces s
    WHERE s.run_id=r.id AND s.erased_at IS NULL;
END $$;
CREATE FUNCTION gov.open_scratch() RETURNS TABLE(workspace_id uuid,run_id uuid,fence bigint,head_hash text,head_seq
  int)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM gov._transaction_barrier(true); RETURN QUERY SELECT * FROM gov._open_scratch();
END $$;
CREATE FUNCTION app.scratch_barrier() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r uuid:=coalesce(NEW.run_id,OLD.run_id);
BEGIN
  IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM app.runs WHERE id=r AND status='erased') THEN RETURN OLD; END IF;
  PERFORM gov._transaction_barrier(true);
  PERFORM 1 FROM app.runs WHERE id=r FOR SHARE;
  PERFORM 1 FROM app.scratch_spaces WHERE run_id=r FOR UPDATE;
  IF sec.current_run() IS DISTINCT FROM r THEN PERFORM sec.refuse('stale scratch writer','40001'); END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE FUNCTION gov.commit_scratch(p_run uuid,p_fence bigint,p_base text,p_tree text) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE s app.scratch_spaces;
BEGIN
  PERFORM gov._transaction_barrier(true);
  PERFORM 1 FROM app.runs WHERE id=p_run FOR SHARE;
  SELECT * INTO STRICT s FROM app.scratch_spaces WHERE run_id=p_run FOR UPDATE;
  IF sec.current_run() IS DISTINCT FROM p_run OR NOT sec.run_alive(p_run,p_fence) OR s.erased_at IS NOT NULL OR
    s.head_hash IS DISTINCT FROM p_base OR p_tree !~ '^([0-9a-f]{40}|[0-9a-f]{64})$' THEN
    PERFORM sec.refuse('stale scratch cut','40001'); END IF;
  INSERT INTO app.scratch_commits VALUES(s.workspace_id,p_run,s.head_seq+1,p_fence,p_base,p_tree);
  UPDATE app.scratch_spaces SET head_seq=head_seq+1,head_hash=p_tree WHERE run_id=p_run; RETURN s.head_seq+1;
END $$;
-- Installation forces tenant RLS on every app table.
CREATE FUNCTION gov._install() RETURNS void LANGUAGE plpgsql AS $$
DECLARE t record; f record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='app' AND NOT rowsecurity LOOP
    EXECUTE format('ALTER TABLE app.%1$I OWNER TO backbone_owner;'
      'ALTER TABLE app.%1$I ENABLE ROW LEVEL SECURITY; ALTER TABLE app.%1$I FORCE ROW LEVEL SECURITY;'
      'CREATE POLICY tenant_wall ON app.%1$I AS RESTRICTIVE FOR ALL TO PUBLIC '
      'USING(%2$I=(SELECT sec.current_workspace())) WITH CHECK(%2$I=(SELECT sec.current_workspace()));'
      'CREATE POLICY gov_all ON app.%1$I FOR ALL TO backbone_gov USING(true) WITH CHECK(true);'
      'GRANT SELECT,INSERT,UPDATE,DELETE ON app.%1$I TO backbone_gov',t.tablename,
      CASE WHEN t.tablename='workspaces' THEN 'id' ELSE 'workspace_id' END);
    IF t.tablename=ANY(ARRAY['people','members','planes','readers','tasks','contract_heads',
      'runs','checker_planes','targets','crossing_inputs','pack_heads']) THEN
      EXECUTE format('ALTER TABLE app.%1$I ADD COLUMN version bigint NOT NULL '
        'DEFAULT nextval(''app.authority_revision''); CREATE TRIGGER revision BEFORE UPDATE ON app.%1$I '
        'FOR EACH ROW EXECUTE FUNCTION app.revision()',t.tablename);
    END IF;
    IF t.tablename=ANY(ARRAY['transfers','executions','intents','snapshots',
      'artifacts','receipts','pack_versions','pack_changes']) THEN
      EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW '
        'EXECUTE FUNCTION app.immutable()',t.tablename);
    END IF;
  END LOOP;
  FOR f IN SELECT oid::regprocedure AS sig FROM pg_proc WHERE pronamespace IN('gov'::regnamespace,
    'sec'::regnamespace,'app'::regnamespace) LOOP
    EXECUTE format('ALTER FUNCTION %1$s SET search_path=pg_catalog,pg_temp;'
      'ALTER FUNCTION %1$s OWNER TO backbone_gov; REVOKE ALL ON FUNCTION %1$s FROM PUBLIC',f.sig);
  END LOOP;
END $$;
SELECT gov._install();
GRANT EXECUTE ON FUNCTION sec.current_workspace(),sec.current_principal(),sec.requested_run(),sec.current_run(),
  sec.effective_principal(),sec.plane_visible(uuid) TO backbone_app;
GRANT EXECUTE ON FUNCTION gov.set_contract(uuid,uuid,jsonb,bool,uuid,float8),gov.revoke_contract(uuid,
  bool),
  gov.propose_support(uuid,uuid,timestamptz),gov.approve_support(uuid),gov.activate_support(uuid),
  gov.revoke_support(uuid),
  gov.propose_contract_recovery(uuid,uuid,uuid,jsonb),gov.accept_contract_recovery(uuid),gov.admit_run(uuid,uuid,jsonb),
  gov.control_run(uuid,text,bool),gov.register_checker(uuid,bool),gov.create_promotion_target(uuid),
  gov.create_promotion_intent(uuid,uuid,text,uuid,text),gov.record_verdict(uuid,text,int,bool),gov.land(text) TO
    backbone_app;
GRANT EXECUTE ON FUNCTION gov.add_person(text,text,bool),
  gov.deactivate_principal(uuid,bool),
  gov.create_plane(text,uuid,uuid[],bool),gov.set_plane_member(uuid,uuid,bool,bool),gov.create_task(uuid,text)
    TO backbone_app;
GRANT USAGE ON SCHEMA gov,sec TO planes_observer,planes_identity;
GRANT EXECUTE ON FUNCTION gov.observe_execution(uuid,bigint,text,text,text,text,text,text),
  gov.observe_execution(uuid,bigint,text,text,text,text,text,text,text),gov.effect_cap(uuid,bigint,text,text)
  TO planes_observer;
-- The door acts with nobody present, so nothing that makes or stands in for a person is granted to it.
GRANT EXECUTE ON FUNCTION gov.authenticate_person(uuid),gov.revoke_contract(uuid,bool),
  gov.add_person(text,text,bool),gov.deactivate_principal(uuid,bool),gov.create_plane(text,uuid,uuid[],bool),
  gov.set_plane_member(uuid,uuid,bool,bool),gov.control_run(uuid,text,bool) TO planes_identity;
GRANT EXECUTE ON FUNCTION gov.open_scratch(),gov.commit_scratch(uuid,bigint,text,text) TO backbone_app;
