-- A recorded source is seen by whoever sees the task or run it was recorded for; one recorded for
-- neither is the workspace's.
CREATE FUNCTION sec.episode_visible(p_task uuid, p_run uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$
  SELECT (p_task IS NULL OR sec.task_visible(p_task)) AND (p_run IS NULL OR sec.run_visible(p_run))
$$;
