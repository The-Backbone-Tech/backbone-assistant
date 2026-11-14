-- Every act outside Backbone's own state, through one door: proposed, decided, claimed, dispatched, observed, reconciled. Never altered, never deleted.
CREATE TABLE app.effects (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id uuid,
  task_id uuid,
  step_seq integer,
  proposer_id uuid NOT NULL,
  on_behalf_of_id uuid,
  mandate_id uuid,
  tool text NOT NULL DEFAULT 'call',
  operation text NOT NULL,
  connection text,
  connection_id uuid,
  project text,
  effect_class smallint NOT NULL CHECK (effect_class BETWEEN 1 AND 6),
  external_party boolean NOT NULL DEFAULT true,
  args jsonb NOT NULL,
  args_hash text NOT NULL,
  description text NOT NULL DEFAULT '',
  expected_version text,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'awaiting_checker', 'allowed', 'denied', 'claimed', 'dispatching', 'succeeded', 'failed', 'unknown', 'cancelled')),
  route text CHECK (route IN ('free', 'allowed', 'allowed_after_window', 'needs_checker', 'denied')),
  route_reason text,
  decision_id uuid,
  undo_of uuid,
  repeat_of uuid,
  not_before timestamptz,
  dispatcher_id uuid,
  external_ref text,
  observation_hash text,
  note text,
  cancel_reason text,
  resolver_id uuid,
  resolve_by timestamptz,
  settled_by uuid,
  -- The hash of the claim a sweep closed as UNKNOWN (gov.settle_lapsed_dispatch); only that claim's late observation reopens it.
  swept_claim_hash text,
  kept boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, run_id) REFERENCES app.runs (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES app.tasks (workspace_id, id),
  FOREIGN KEY (workspace_id, proposer_id) REFERENCES app.principals (workspace_id, id),
  FOREIGN KEY (workspace_id, mandate_id) REFERENCES app.mandates (workspace_id, id),
  FOREIGN KEY (workspace_id, undo_of) REFERENCES app.effects (workspace_id, id),
  FOREIGN KEY (workspace_id, repeat_of) REFERENCES app.effects (workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (status <> 'unknown' OR (resolver_id IS NOT NULL AND resolve_by IS NOT NULL AND observation_hash IS NOT NULL)),
  CHECK (repeat_of IS NULL OR route IS NOT NULL)
);
ALTER TABLE app.effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.effects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.effects AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.effects FOR SELECT TO backbone_app USING (sec.effect_visible(id));
CREATE POLICY crossings ON app.effects FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.effects FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE INDEX effects_task ON app.effects (workspace_id, task_id, operation);
CREATE INDEX effects_run ON app.effects (workspace_id, run_id);
CREATE INDEX effects_undo ON app.effects (workspace_id, undo_of);
CREATE TRIGGER rules BEFORE INSERT OR UPDATE OR DELETE ON app.effects FOR EACH ROW EXECUTE FUNCTION sec.t_effect();
CREATE CONSTRAINT TRIGGER lineage AFTER INSERT OR UPDATE ON app.effects DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sec.t_effect_lineage();
GRANT SELECT ON app.effects TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.effects TO backbone_gov;
