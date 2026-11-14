-- Hold the session workspace's ledger head until commit: the crossings that must see each other's
-- writes (budgets, duplicate detection, dispatch) take it first.
CREATE FUNCTION gov._lock_workspace() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  PERFORM 1 FROM app.ledger_heads WHERE workspace_id = sec.current_workspace() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no_identity: the session names no workspace';
  END IF;
END
$$;
