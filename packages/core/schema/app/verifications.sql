-- A verifier's persisted answer: the proof that the verdict came from the verifier's own reading of the exact proposal.
CREATE TABLE app.verifications (
workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  decision_id uuid NOT NULL,
  verifier_id uuid NOT NULL,
  proposal_hash text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('approved', 'rejected')),
  reason text NOT NULL,
  response_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, decision_id) REFERENCES app.decisions (workspace_id, id),
  FOREIGN KEY (workspace_id, verifier_id) REFERENCES app.principals (workspace_id, id)
);
ALTER TABLE app.verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON app.verifications AS RESTRICTIVE FOR ALL TO PUBLIC USING (workspace_id = (SELECT sec.current_workspace())) WITH CHECK (workspace_id = (SELECT sec.current_workspace()));
CREATE POLICY readers ON app.verifications FOR SELECT TO backbone_app USING (sec.decision_visible(decision_id));
CREATE POLICY crossings ON app.verifications FOR ALL TO backbone_gov USING (true) WITH CHECK (true);
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.verifications FOR EACH STATEMENT EXECUTE FUNCTION sec.t_refuse_truncate();
CREATE TRIGGER evidence BEFORE UPDATE OR DELETE ON app.verifications FOR EACH ROW EXECUTE FUNCTION sec.t_evidence();
GRANT SELECT ON app.verifications TO backbone_app;
GRANT SELECT, INSERT, UPDATE ON app.verifications TO backbone_gov;
