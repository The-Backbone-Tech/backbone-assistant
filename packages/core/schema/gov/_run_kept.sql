-- A run marked both ways in the sense that keeps its work: it read untrusted content and private
-- material from beyond its own conversation. What it writes where others read stays with its
-- person, and its decider.
CREATE FUNCTION gov._run_kept(p_run uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT coalesce((SELECT r.tainted_untrusted AND r.elsewhere_source IS NOT NULL FROM app.runs r
                   WHERE r.workspace_id = sec.current_workspace() AND r.id = p_run), false)
$$;
