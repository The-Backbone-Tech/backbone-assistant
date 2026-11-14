-- The workspace's cancellation window for delayable effects: an owner's or admin's to set.
CREATE FUNCTION gov.set_delay_window(p_ms integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  PERFORM gov._admin();
  IF p_ms IS NULL OR p_ms < 0 OR p_ms > 86400000 THEN
    RAISE EXCEPTION 'invalid: the window is between 0 and 24 hours';
  END IF;
  UPDATE app.workspaces SET delay_window_ms = p_ms WHERE id = sec.current_workspace();
  PERFORM gov._append('workspace.window_set', sec.current_workspace()::text, jsonb_build_object('ms', p_ms));
  RETURN p_ms;
END
$$;
