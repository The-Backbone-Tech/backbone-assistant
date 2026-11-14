-- Every task entry point receives a private project before subsequent writes.
-- A project-aware creator may replace this default binding in the same transaction.
CREATE OR REPLACE FUNCTION gov.identity_bind_new_task() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE prior_workspace text:=current_setting('backbone.workspace',true);
BEGIN
  -- The tasks INSERT has already passed its own authority checks. The trigger
  -- binds only that accepted row, including privileged imports without a session.
  PERFORM set_config('backbone.workspace',NEW.workspace_id::text,true);
  INSERT INTO app.identity_projects(workspace_id,project_id,owner_id) VALUES(NEW.workspace_id,NEW.id,NEW.requested_by);
  INSERT INTO app.identity_task_projects(workspace_id,task_id,project_id) VALUES(NEW.workspace_id,NEW.id,NEW.id);
  INSERT INTO app.identity_project_people(workspace_id,project_id,person_id,access)
  SELECT NEW.workspace_id,NEW.id,p.id,CASE WHEN p.role='guest' THEN 'viewer' ELSE 'editor' END
  FROM app.principals p WHERE p.workspace_id=NEW.workspace_id AND p.kind='person' AND p.status='active' AND p.id<>NEW.requested_by
    AND (p.id=NEW.on_behalf_of OR NEW.visibility='workspace');
  IF NEW.visibility='workspace' THEN INSERT INTO app.identity_workspace_projects(workspace_id,project_id) VALUES(NEW.workspace_id,NEW.id); END IF;
  PERFORM set_config('backbone.workspace',coalesce(prior_workspace,''),true);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('backbone.workspace',coalesce(prior_workspace,''),true);
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_bind_new_task() FROM PUBLIC,backbone_app,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_bind_new_task() TO backbone_owner;
