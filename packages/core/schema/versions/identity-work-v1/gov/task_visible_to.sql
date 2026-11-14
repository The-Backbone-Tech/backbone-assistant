-- The table-owner policy bindings are complete; retain the original namespace grants.
REVOKE USAGE ON SCHEMA gov FROM backbone_owner;
-- Keep legacy audiences, while checking current project access for the named reader.
CREATE OR REPLACE FUNCTION sec.task_visible_to(p_task uuid,p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
  SELECT gov.identity_person_task_access(p_task,p_person,false) AND EXISTS (
    SELECT FROM app.tasks t
    WHERE t.workspace_id=sec.current_workspace() AND t.id=p_task
      AND (t.visibility='workspace' OR p_person IN(t.requested_by,t.on_behalf_of)
        OR EXISTS(SELECT FROM app.task_people tp WHERE tp.workspace_id=t.workspace_id AND tp.task_id=t.id AND tp.person_id=p_person)))
$$;
