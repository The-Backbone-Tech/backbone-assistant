-- Preserve the paired channel join as an explicit project grant. The service
-- lookup is bounded to that paired account; no message content is returned.
CREATE OR REPLACE FUNCTION gov.join_channel_thread(p_thread uuid,p_identity uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE ws uuid:=sec.current_workspace(); me uuid:=gov._person('not_by_runs'); old_person text:=coalesce(current_setting('backbone.principal',true),''); account uuid; task uuid; project uuid;
BEGIN
  SELECT account_id INTO account FROM app.channel_identities WHERE workspace_id=ws AND id=p_identity AND person_id=me;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found: no such paired identity'; END IF;
  PERFORM set_config('backbone.principal',sec.system_principal()::text,true);
  SELECT task_id INTO task FROM app.channel_threads WHERE workspace_id=ws AND id=p_thread AND account_id=account;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found: no such thread for this paired identity'; END IF;
  SELECT project_id INTO project FROM app.identity_task_projects WHERE workspace_id=ws AND task_id=task;
  IF NOT FOUND THEN RAISE EXCEPTION 'denied: no project binding'; END IF;
  IF EXISTS(SELECT FROM app.task_people WHERE workspace_id=ws AND task_id=task AND person_id=me)
    AND NOT EXISTS(SELECT FROM app.identity_projects WHERE workspace_id=ws AND project_id=project AND owner_id=me)
    AND NOT EXISTS(SELECT FROM app.identity_project_people WHERE workspace_id=ws AND project_id=project AND person_id=me)
    THEN RAISE EXCEPTION 'denied: project access ended'; END IF;
  INSERT INTO app.identity_project_people(workspace_id,project_id,person_id,access)
    SELECT ws,project,me,CASE WHEN sec.role_of(me)='guest' THEN 'viewer' ELSE 'editor' END
    WHERE NOT EXISTS(SELECT FROM app.identity_projects WHERE workspace_id=ws AND project_id=project AND owner_id=me)
    ON CONFLICT(workspace_id,project_id,person_id) DO NOTHING;
  INSERT INTO app.task_people(workspace_id,task_id,person_id) VALUES(ws,task,me) ON CONFLICT DO NOTHING;
  PERFORM set_config('backbone.principal',old_person,true);
  PERFORM gov._append('channel.thread_joined',p_thread::text,jsonb_build_object('person',me));
  RETURN task;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('backbone.principal',old_person,true);RAISE;
END
$$;
