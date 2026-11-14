-- Private, payload-free accounting sees the whole mandate subtree. General run
-- and effect SELECT policies remain restricted to the caller's project/secret.
CREATE FUNCTION gov.identity_budget_totals(p_mandate uuid) RETURNS TABLE(tokens numeric,cost numeric,effects bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE old_person text:=coalesce(current_setting('backbone.principal',true),''); old_run text:=coalesce(current_setting('backbone.run',true),''); old_secret text:=coalesce(current_setting('backbone.secret',true),'');
BEGIN
  PERFORM set_config('backbone.run','',true); PERFORM set_config('backbone.secret','',true); PERFORM set_config('backbone.principal',sec.system_principal()::text,true);
  SELECT coalesce(sum(r.tokens_used),0),coalesce(sum(r.cost_micros),0) INTO tokens,cost
  FROM app.runs r WHERE r.workspace_id=sec.current_workspace() AND r.mandate_id IN(SELECT gov._subtree(p_mandate));
  SELECT count(*) INTO effects FROM app.effects e WHERE e.workspace_id=sec.current_workspace()
    AND e.mandate_id IN(SELECT gov._subtree(p_mandate)) AND e.status NOT IN('denied','cancelled');
  PERFORM set_config('backbone.principal',old_person,true); PERFORM set_config('backbone.run',old_run,true); PERFORM set_config('backbone.secret',old_secret,true);
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('backbone.principal',old_person,true); PERFORM set_config('backbone.run',old_run,true); PERFORM set_config('backbone.secret',old_secret,true);
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_budget_totals(uuid) FROM PUBLIC,backbone_app,backbone_operator;
