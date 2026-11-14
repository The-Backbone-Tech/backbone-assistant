-- The company's accepted knowledge: changed only by promotion, retracted by its owner or an admin, never rewritten.
CREATE TABLE app.knowledge (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  statement text NOT NULL,
  topic text NOT NULL,
  owner_id uuid NOT NULL,
  valid_from timestamptz,
  valid_to timestamptz,
  words_untrusted boolean NOT NULL DEFAULT false,
  accepted_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'retracted')),
  retracted_reason text,
  retracted_by uuid,
  retracted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, candidate_id),
  FOREIGN KEY (workspace_id, candidate_id) REFERENCES app.knowledge_candidates (workspace_id, id),
  FOREIGN KEY (workspace_id, decision_id) REFERENCES app.decisions (workspace_id, id),
  FOREIGN KEY (workspace_id, owner_id) REFERENCES app.principals (workspace_id, id)
);
ALTER TABLE app.knowledge ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.knowledge FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.knowledge AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.knowledge FOR SELECT TO backbone_app USING (NOT sec.names_run() OR (NOT words_untrusted AND candidate_id IN (SELECT sec.visible_eligible_knowledge_sources())));
CREATE POLICY crossings ON app.knowledge FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER material_source_guard BEFORE INSERT ON app.knowledge FOR EACH ROW EXECUTE FUNCTION sec.t_material_promotion_guard();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.knowledge FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER rules BEFORE UPDATE OR DELETE ON app.knowledge FOR EACH ROW EXECUTE FUNCTION sec.t_knowledge();
GRANT SELECT ON app.knowledge TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.knowledge TO backbone_gov;
