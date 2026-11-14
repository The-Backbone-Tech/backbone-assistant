-- The synchronous task trigger installs the binding after this validated insertion.
DROP POLICY identity_project_insert ON app.tasks;
CREATE POLICY identity_project_insert ON app.tasks AS RESTRICTIVE FOR INSERT TO backbone_gov
  WITH CHECK(sec.current_principal()=sec.system_principal() OR (requested_by=sec.current_principal() AND sec.role_of(requested_by) IN('owner','admin','member')));
CREATE TRIGGER identity_task_project_binding AFTER INSERT ON app.tasks FOR EACH ROW EXECUTE FUNCTION gov.identity_bind_new_task();
-- Run-name lookup is required for validating its secret without recursive RLS.
-- An admin role alone confers no read of a project's run or effect payload.
DROP POLICY identity_project_crossing_read ON app.runs;
CREATE POLICY identity_project_crossing_read ON app.runs AS RESTRICTIVE FOR SELECT TO backbone_gov
  USING(CASE WHEN sec.names_run() THEN gov.identity_run_lookup(id,fence) ELSE gov.identity_task_access(task_id,false) OR gov.identity_run_decider_access(id) END);
DROP POLICY identity_project_crossing_read ON app.effects;
CREATE POLICY identity_project_crossing_read ON app.effects AS RESTRICTIVE FOR SELECT TO backbone_gov USING(gov.identity_task_access(task_id,false) OR gov.identity_effect_decider_access(decision_id));
-- The assigned decider retains the native rule-of-two view and can settle that
-- proposal through the existing guarded crossing. This is never a role-wide read.
DROP POLICY identity_project_read ON app.effects;
CREATE POLICY identity_project_read ON app.effects AS RESTRICTIVE FOR SELECT TO backbone_app
  USING(gov.identity_task_access(task_id,false) OR gov.identity_effect_decider_access(decision_id));
DROP POLICY identity_project_update ON app.effects;
CREATE POLICY identity_project_update ON app.effects AS RESTRICTIVE FOR UPDATE TO backbone_gov USING(true)
  WITH CHECK(gov.identity_task_access(task_id,true) OR gov.identity_effect_decider_access(decision_id) OR (status='cancelled' AND sec.is_admin(sec.current_principal())));
