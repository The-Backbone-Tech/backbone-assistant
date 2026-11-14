-- A verifier records what it spent; returns what the workspace's verifiers may still spend today.
CREATE FUNCTION gov.record_verifier_usage(p_tokens bigint) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := sec.current_principal();
BEGIN
  IF me IS NULL OR sec.names_run() OR NOT sec.is_verifier(me) THEN
    RAISE EXCEPTION 'role: only a verifier records verifier usage';
  END IF;
  IF p_tokens IS NULL OR p_tokens < 0 THEN
    RAISE EXCEPTION 'invalid: usage is never negative';
  END IF;
  INSERT INTO app.verifier_usage (workspace_id, day, tokens)
  VALUES (sec.current_workspace(), (clock_timestamp() AT TIME ZONE 'UTC')::date, p_tokens)
  ON CONFLICT (workspace_id, day) DO UPDATE SET tokens = app.verifier_usage.tokens + excluded.tokens;
  RETURN gov.verifier_allowance();
END
$$;
