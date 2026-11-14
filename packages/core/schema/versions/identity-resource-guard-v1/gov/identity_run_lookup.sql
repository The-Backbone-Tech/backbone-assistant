-- Validate the one claimed row without reading app.runs and recursing through RLS.
-- This permits native claim/holder accounting, not a run-name-only read bypass.
CREATE FUNCTION gov.identity_run_lookup(p_run uuid,p_fence bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
  SELECT p_run=nullif(current_setting('backbone.run',true),'')::uuid AND EXISTS(
    SELECT FROM ops.run_secrets s WHERE s.workspace_id=sec.current_workspace() AND s.run_id=p_run AND s.fence=p_fence
      AND s.secret_hash=encode(sha256(convert_to(coalesce(current_setting('backbone.secret',true),''),'UTF8')),'hex'))
$$;
REVOKE ALL ON FUNCTION gov.identity_run_lookup(uuid,bigint) FROM PUBLIC,backbone_app,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_run_lookup(uuid,bigint) TO backbone_owner;
