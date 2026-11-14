-- One attempt by an agent at a task under a mandate, carried by the registered piece it was queued with (if any): claimed by a worker under a fenced lease. Its marks record what it read, and only rise.
CREATE TABLE app.runs (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  mandate_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  stop_reason text,
  fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
  worker text,
  lease_expires_at timestamptz,
  woken boolean NOT NULL DEFAULT false,
  tokens_used bigint NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  cost_micros bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  tainted_untrusted boolean NOT NULL DEFAULT false,
  tainted_sensitive boolean NOT NULL DEFAULT false,
  untrusted_source text,
  sensitive_source text,
  elsewhere_source text,
  routine_id uuid,
  -- Its mandate's kind and piece, copied when it is queued (sec.t_run_piece); a worker claims it only for exactly these.
  carrier text NOT NULL CHECK (carrier IN ('piece', 'direct')),
  piece_id uuid,
  carrier_key text GENERATED ALWAYS AS (coalesce(piece_id::text, carrier)) STORED,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES app.tasks (workspace_id, id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES app.principals (workspace_id, id),
  FOREIGN KEY (workspace_id, mandate_id) REFERENCES app.mandates (workspace_id, id),
  FOREIGN KEY (workspace_id, piece_id) REFERENCES app.pieces (workspace_id, id),
  UNIQUE (workspace_id, id, carrier_key),
  CHECK ((carrier = 'piece') = (piece_id IS NOT NULL)),
  CHECK (tainted_untrusted = (untrusted_source IS NOT NULL)),
  CHECK (tainted_sensitive = (sensitive_source IS NOT NULL))
);
ALTER TABLE app.runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.runs AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.runs FOR SELECT TO backbone_app USING (sec.task_visible(task_id));
CREATE POLICY crossings ON app.runs FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.runs FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE INDEX runs_task ON app.runs (workspace_id, task_id);
CREATE INDEX runs_mandate ON app.runs (workspace_id, mandate_id);
CREATE TRIGGER marks BEFORE UPDATE OR DELETE ON app.runs FOR EACH ROW EXECUTE FUNCTION sec.t_run_marks();
CREATE TRIGGER piece BEFORE INSERT OR UPDATE ON app.runs FOR EACH ROW EXECUTE FUNCTION sec.t_run_piece();
CREATE INDEX runs_piece ON app.runs (workspace_id, piece_id);
GRANT SELECT (workspace_id, id, task_id, agent_id, mandate_id, status, stop_reason, fence, worker, lease_expires_at, woken, tokens_used, cost_micros, tainted_untrusted, tainted_sensitive, routine_id, carrier, piece_id, carrier_key, created_at, started_at, finished_at) ON app.runs TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.runs TO backbone_gov;
