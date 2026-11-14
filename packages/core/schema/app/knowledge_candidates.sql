-- A statement proposed for accepted knowledge, with verbatim evidence. Its claim never changes; its terms are set once.
CREATE TABLE app.knowledge_candidates (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  statement text NOT NULL CHECK (length(statement) BETWEEN 1 AND 4000),
  topic text NOT NULL,
  evidence jsonb NOT NULL,
  proposed_by uuid NOT NULL,
  run_id uuid,
  on_behalf_of uuid,
  owner_id uuid,
  valid_from timestamptz,
  valid_to timestamptz,
  terms_hash text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'withdrawn')),
  words_untrusted boolean NOT NULL DEFAULT false,
  kept boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, proposed_by) REFERENCES app.principals (workspace_id, id),
  FOREIGN KEY (workspace_id, owner_id) REFERENCES app.principals (workspace_id, id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES app.runs (workspace_id, id)
);
ALTER TABLE app.knowledge_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.knowledge_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.knowledge_candidates AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.knowledge_candidates FOR SELECT TO backbone_app USING (sec.candidate_visible(id) AND (NOT sec.names_run() OR id IN (SELECT sec.visible_eligible_knowledge_sources())));
CREATE POLICY crossings ON app.knowledge_candidates FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.knowledge_candidates FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER rules BEFORE UPDATE OR DELETE ON app.knowledge_candidates FOR EACH ROW EXECUTE FUNCTION sec.t_candidate();
GRANT SELECT ON app.knowledge_candidates TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.knowledge_candidates TO backbone_gov;
