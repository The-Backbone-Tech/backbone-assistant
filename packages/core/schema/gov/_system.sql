-- The session's principal as the workspace's system principal, outside any run, or refused.
CREATE FUNCTION gov._system(p_reason text DEFAULT 'system_dispatches') RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := sec.current_principal();
BEGIN
  IF me IS NULL OR sec.names_run() OR me IS DISTINCT FROM sec.system_principal() THEN
    RAISE EXCEPTION '%: only the workspace''s system principal does this, outside any run', p_reason;
  END IF;
  RETURN me;
END
$$;
