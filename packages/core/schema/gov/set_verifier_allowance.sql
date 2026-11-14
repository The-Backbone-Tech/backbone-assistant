-- An owner or admin sets what the workspace's verifiers may spend per day, in tokens.
CREATE FUNCTION gov.set_verifier_allowance(p_tokens bigint) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  PERFORM gov._admin();
  IF p_tokens IS NULL OR p_tokens < 0 THEN
    RAISE EXCEPTION 'invalid: an allowance is zero or more tokens';
  END IF;
  UPDATE app.workspaces SET verifier_allowance = p_tokens WHERE id = sec.current_workspace();
  PERFORM gov._append('workspace.verifier_allowance_set', sec.current_workspace()::text, jsonb_build_object('tokens', p_tokens));
  RETURN p_tokens;
END
$$;
