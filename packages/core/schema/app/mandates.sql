-- Authority an agent holds for a person: a set-spec per axis, a ceiling, a budget, an expiry and a locked intent, and the registered piece it was granted to, if any. Children only narrow.
CREATE TABLE app.mandates (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  issuer_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  on_behalf_of_id uuid NOT NULL,
  parent_id uuid,
  projects jsonb NOT NULL DEFAULT '"*"',
  connections jsonb NOT NULL DEFAULT '"*"',
  tools jsonb NOT NULL DEFAULT '"*"',
  operations jsonb NOT NULL DEFAULT '"*"',
  ceiling smallint NOT NULL CHECK (ceiling BETWEEN 1 AND 4),
  max_tokens bigint CHECK (max_tokens >= 0),
  max_cost_micros bigint CHECK (max_cost_micros >= 0),
  max_duration_ms bigint CHECK (max_duration_ms >= 0),
  max_effects bigint CHECK (max_effects >= 0),
  expires_at timestamptz NOT NULL,
  intent jsonb NOT NULL DEFAULT '{}',
  intent_hash text NOT NULL DEFAULT '',
  -- What carries the work, stated by the person when they grant it: a registered piece ('piece', and
  -- its effects never exceed that piece's declaration), or 'direct' (their own direct work, or code
  -- the installation trusts as itself, such as the platform's stub). Never inferred from a missing piece.
  carrier text NOT NULL CHECK (carrier IN ('piece', 'direct')),
  piece_id uuid,
  revoked_at timestamptz,
  revoked_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, issuer_id) REFERENCES app.principals (workspace_id, id),
  FOREIGN KEY (workspace_id, subject_id) REFERENCES app.principals (workspace_id, id),
  FOREIGN KEY (workspace_id, on_behalf_of_id) REFERENCES app.principals (workspace_id, id),
  FOREIGN KEY (workspace_id, parent_id) REFERENCES app.mandates (workspace_id, id),
  FOREIGN KEY (workspace_id, piece_id) REFERENCES app.pieces (workspace_id, id),
  CHECK ((carrier = 'piece') = (piece_id IS NOT NULL)),
  CHECK (jsonb_typeof(projects) IN ('string', 'array') AND jsonb_typeof(connections) IN ('string', 'array')
         AND jsonb_typeof(tools) IN ('string', 'array') AND jsonb_typeof(operations) IN ('string', 'array'))
);
ALTER TABLE app.mandates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.mandates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.mandates AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.mandates FOR SELECT TO backbone_app USING (true);
CREATE POLICY crossings ON app.mandates FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.mandates FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE INDEX mandates_parent ON app.mandates (workspace_id, parent_id);
CREATE TRIGGER rules BEFORE INSERT OR UPDATE OR DELETE ON app.mandates FOR EACH ROW EXECUTE FUNCTION sec.t_mandate();
GRANT SELECT ON app.mandates TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.mandates TO backbone_gov;
