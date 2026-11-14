-- Source eligibility is independent of the checker's project audience. Only a
-- boolean leaves this bounded private observation; kept payloads remain private.
CREATE OR REPLACE FUNCTION gov._promotion_sources_allowed(p_candidate uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE old_person text:=coalesce(current_setting('backbone.principal',true),''); old_run text:=coalesce(current_setting('backbone.run',true),''); old_secret text:=coalesce(current_setting('backbone.secret',true),''); allowed boolean;
BEGIN
  PERFORM set_config('backbone.run','',true); PERFORM set_config('backbone.secret','',true); PERFORM set_config('backbone.principal',sec.system_principal()::text,true);
  SELECT EXISTS(SELECT FROM gov.eligible_knowledge_sources WHERE candidate_id=p_candidate) INTO allowed;
  PERFORM set_config('backbone.principal',old_person,true); PERFORM set_config('backbone.run',old_run,true); PERFORM set_config('backbone.secret',old_secret,true);
  RETURN allowed;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('backbone.principal',old_person,true); PERFORM set_config('backbone.run',old_run,true); PERFORM set_config('backbone.secret',old_secret,true);
  RAISE;
END
$$;
