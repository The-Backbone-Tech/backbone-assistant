-- The operator's view of queue membership (SG-LED-02): per workspace, how many runs, effects and
-- verifier questions wait in each queue, and how many of them are claimable now. Counts only.
CREATE FUNCTION operator.queue_depth() RETURNS TABLE (workspace_id uuid, queue text, waiting bigint, claimable bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT q.workspace_id, 'runs', count(*), count(*) FILTER (WHERE q.claimable_after <= clock_timestamp()) FROM ops.run_queue q GROUP BY 1
  UNION ALL
  SELECT q.workspace_id, 'effects', count(*), count(*) FILTER (WHERE q.due_at <= clock_timestamp()) FROM ops.effect_queue q GROUP BY 1
  UNION ALL
  SELECT q.workspace_id, 'verification', count(*), count(*) FILTER (WHERE q.available_at <= clock_timestamp()) FROM ops.verification_queue q GROUP BY 1
  ORDER BY 1, 2
$$;
