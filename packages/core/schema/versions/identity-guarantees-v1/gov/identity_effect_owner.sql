-- Private native refusal classification; never an alternate payload read API.
CREATE FUNCTION gov.identity_effect_owner(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE old_person text:=coalesce(current_setting('backbone.principal',true),''); old_run text:=coalesce(current_setting('backbone.run',true),''); old_secret text:=coalesce(current_setting('backbone.secret',true),''); value jsonb;
BEGIN
  PERFORM set_config('backbone.run','',true); PERFORM set_config('backbone.secret','',true); PERFORM set_config('backbone.principal',sec.system_principal()::text,true);
  SELECT (SELECT jsonb_build_object('person',on_behalf_of_id) FROM app.effects WHERE workspace_id=sec.current_workspace() AND id=p_id) INTO value;
  PERFORM set_config('backbone.principal',old_person,true); PERFORM set_config('backbone.run',old_run,true); PERFORM set_config('backbone.secret',old_secret,true);
  RETURN value;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('backbone.principal',old_person,true); PERFORM set_config('backbone.run',old_run,true); PERFORM set_config('backbone.secret',old_secret,true); RAISE;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_effect_owner(uuid) FROM PUBLIC,backbone_app,backbone_operator;
