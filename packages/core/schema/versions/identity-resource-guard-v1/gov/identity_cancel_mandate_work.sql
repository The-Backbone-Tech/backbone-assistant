-- A private cancellation service acts only on already-revoked mandates whose
-- revocation the caller could authorize. It never returns runs or effect bodies.
CREATE FUNCTION gov.identity_cancel_mandate_work(p_mandates uuid[],p_actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE r record; old_person text:=coalesce(current_setting('backbone.principal',true),''); old_run text:=coalesce(current_setting('backbone.run',true),''); old_secret text:=coalesce(current_setting('backbone.secret',true),'');
BEGIN
  IF p_actor IS NULL OR sec.current_principal() IS DISTINCT FROM p_actor OR p_mandates IS NULL
    OR EXISTS(SELECT FROM unnest(p_mandates) x(id) LEFT JOIN app.mandates m ON m.workspace_id=sec.current_workspace() AND m.id=x.id
      WHERE m.id IS NULL OR m.revoked_at IS NULL OR NOT(p_actor IN(m.issuer_id,m.on_behalf_of_id) OR (NOT sec.names_run() AND sec.is_admin(p_actor))))
    THEN RAISE EXCEPTION 'denied: cancellation requires an authorized revoked mandate'; END IF;
  PERFORM set_config('backbone.run','',true); PERFORM set_config('backbone.secret','',true);
  PERFORM set_config('backbone.principal',sec.system_principal()::text,true);
  FOR r IN SELECT id FROM app.runs WHERE workspace_id=sec.current_workspace() AND mandate_id=ANY(p_mandates) AND status IN('queued','running','waiting') LOOP
    PERFORM gov._stop_run(r.id,'cancelled','mandate revoked');
  END LOOP;
  FOR r IN SELECT id FROM app.effects WHERE workspace_id=sec.current_workspace() AND mandate_id=ANY(p_mandates) AND status IN('proposed','awaiting_checker','allowed','claimed') LOOP
    PERFORM gov._cancel_effect(r.id,'mandate revoked');
  END LOOP;
  PERFORM gov._append('identity.mandate_work_cancelled',p_actor::text,jsonb_build_object('mandates',p_mandates),p_actor);
  PERFORM set_config('backbone.principal',old_person,true); PERFORM set_config('backbone.run',old_run,true); PERFORM set_config('backbone.secret',old_secret,true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('backbone.principal',old_person,true); PERFORM set_config('backbone.run',old_run,true); PERFORM set_config('backbone.secret',old_secret,true);
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_cancel_mandate_work(uuid[],uuid) FROM PUBLIC,backbone_app,backbone_operator;
