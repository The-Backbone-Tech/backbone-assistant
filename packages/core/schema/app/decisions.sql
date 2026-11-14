-- A question asked once, at the real crossing, of a checker other than its maker. Answered once; void if the proposal changed.
CREATE TABLE app.decisions (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subject_kind text NOT NULL CHECK (subject_kind IN ('effect', 'promotion', 'elevation')),
  subject_id uuid NOT NULL,
  proposer_id uuid NOT NULL,
  on_behalf_of_id uuid,
  checker_kind text NOT NULL CHECK (checker_kind IN ('person', 'verifier')),
  checker_id uuid,
  reason text NOT NULL,
  is_strict boolean NOT NULL DEFAULT false,
  proposal_hash text NOT NULL,
  question text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'withdrawn')),
  answered_by uuid,
  answered_at timestamptz,
  note text,
  escalation_note text,
  escalated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, proposer_id) REFERENCES app.principals (workspace_id, id),
  FOREIGN KEY (workspace_id, checker_id) REFERENCES app.principals (workspace_id, id),
  FOREIGN KEY (workspace_id, answered_by) REFERENCES app.principals (workspace_id, id)
);
ALTER TABLE app.decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.decisions AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.decisions FOR SELECT TO backbone_app USING (sec.decision_visible(id) AND (NOT sec.names_run() OR subject_kind <> 'promotion' OR subject_id IN (SELECT sec.visible_eligible_knowledge_sources())));
CREATE POLICY crossings ON app.decisions FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.decisions FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE UNIQUE INDEX decisions_one_open ON app.decisions (workspace_id, subject_id) WHERE status = 'open';
CREATE TRIGGER rules BEFORE UPDATE OR DELETE ON app.decisions FOR EACH ROW EXECUTE FUNCTION sec.t_decision();
GRANT SELECT ON app.decisions TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.decisions TO backbone_gov;
