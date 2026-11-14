-- Preserve the native API's explicit workspace documents without reopening the
-- general task guard for missing bindings or unnamed sessions.
DROP POLICY identity_project_read ON app.documents;
CREATE POLICY identity_project_read ON app.documents AS RESTRICTIVE FOR SELECT TO backbone_app USING(gov.identity_material_scope(task_id,false));
DROP POLICY identity_project_crossing_read ON app.documents;
CREATE POLICY identity_project_crossing_read ON app.documents AS RESTRICTIVE FOR SELECT TO backbone_gov USING(gov.identity_material_scope(task_id,false));
DROP POLICY identity_project_insert ON app.documents;
CREATE POLICY identity_project_insert ON app.documents AS RESTRICTIVE FOR INSERT TO backbone_gov WITH CHECK(gov.identity_material_scope(task_id,true));
DROP POLICY identity_project_update ON app.documents;
CREATE POLICY identity_project_update ON app.documents AS RESTRICTIVE FOR UPDATE TO backbone_gov USING(true) WITH CHECK(gov.identity_material_scope(task_id,true));
-- A source explicitly recorded for neither a task nor a run is workspace
-- evidence. The native recorder checks its origin; project sources keep their binding.
DROP POLICY identity_project_read ON app.episodes;
CREATE POLICY identity_project_read ON app.episodes AS RESTRICTIVE FOR SELECT TO backbone_app USING(CASE WHEN task_id IS NULL AND run_id IS NOT NULL THEN gov.identity_run_access(run_id,false) ELSE gov.identity_material_scope(task_id,false) END);
DROP POLICY identity_project_crossing_read ON app.episodes;
CREATE POLICY identity_project_crossing_read ON app.episodes AS RESTRICTIVE FOR SELECT TO backbone_gov USING(CASE WHEN task_id IS NULL AND run_id IS NOT NULL THEN gov.identity_run_access(run_id,false) ELSE gov.identity_material_scope(task_id,false) END);
DROP POLICY identity_project_insert ON app.episodes;
CREATE POLICY identity_project_insert ON app.episodes AS RESTRICTIVE FOR INSERT TO backbone_gov WITH CHECK(CASE WHEN task_id IS NULL AND run_id IS NOT NULL THEN gov.identity_run_access(run_id,true) ELSE gov.identity_material_scope(task_id,true) END);
DROP POLICY identity_project_update ON app.episodes;
CREATE POLICY identity_project_update ON app.episodes AS RESTRICTIVE FOR UPDATE TO backbone_gov USING(true) WITH CHECK(CASE WHEN task_id IS NULL AND run_id IS NOT NULL THEN gov.identity_run_access(run_id,true) ELSE gov.identity_material_scope(task_id,true) END);
