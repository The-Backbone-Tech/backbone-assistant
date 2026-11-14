-- Whether the holder's run may go on: 'ok', 'stopped', or why its mandate no longer stands.
CREATE FUNCTION gov.run_standing(p_run uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  r app.runs := gov._holder(p_run, NULL);
  standing text := gov._mandate_standing(r.mandate_id);
BEGIN
  IF standing <> 'ok' THEN
    RETURN standing;
  END IF;
  RETURN CASE WHEN r.status = 'running' THEN 'ok' ELSE 'stopped' END;
END
$$;
