-- A piece (a module or a surface) the person or an admin registered: its id, version, content digest and declared capabilities, which the gateway enforces on every run bound to it. Never altered: an upgrade is a new registration, and unregistering only ends one.
CREATE TABLE app.pieces (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  piece text NOT NULL CHECK (piece ~ '^[a-z0-9]+(\.[a-z0-9-]+)+/[a-z0-9][a-z0-9-]*$'),
  kind text NOT NULL CHECK (kind IN ('module', 'surface')),
  version text NOT NULL CHECK (version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'),
  -- The content's sha256, never a git reference: a branch or tag can name other content tomorrow.
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  planes jsonb NOT NULL CHECK (jsonb_typeof(planes) = 'array' AND planes <@ '["personal", "team", "company"]'::jsonb),
  operations jsonb NOT NULL CHECK (jsonb_typeof(operations) = 'array'),
  effect_classes smallint[] NOT NULL CHECK (effect_classes <@ ARRAY[1, 2, 3, 4, 5, 6]::smallint[]),
  -- The highest declared class (0: none), set by sec.t_piece. Anything above it is refused, whatever the mandate allows.
  effect_ceiling smallint NOT NULL CHECK (effect_ceiling BETWEEN 0 AND 6),
  network jsonb NOT NULL CHECK (jsonb_typeof(network) = 'array'),
  secrets text NOT NULL CHECK (secrets IN ('none', 'surrogate')),
  manifest jsonb NOT NULL,
  registered_by uuid NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  unregistered_at timestamptz,
  unregistered_by uuid,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, registered_by) REFERENCES app.principals (workspace_id, id),
  FOREIGN KEY (workspace_id, unregistered_by) REFERENCES app.principals (workspace_id, id),
  CHECK ((unregistered_at IS NULL) = (unregistered_by IS NULL))
);
ALTER TABLE app.pieces ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.pieces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.pieces AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.pieces FOR SELECT TO backbone_app USING (true);
CREATE POLICY crossings ON app.pieces FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.pieces FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
-- One standing registration per content: the same digest is never registered twice at once.
CREATE UNIQUE INDEX pieces_standing ON app.pieces (workspace_id, piece, digest) WHERE unregistered_at IS NULL;
CREATE TRIGGER rules BEFORE INSERT OR UPDATE OR DELETE ON app.pieces FOR EACH ROW EXECUTE FUNCTION sec.t_piece();
GRANT SELECT ON app.pieces TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.pieces TO backbone_gov;
