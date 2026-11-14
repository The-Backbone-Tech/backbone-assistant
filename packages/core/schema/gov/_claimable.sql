-- Whether a locked run may be claimed now: queued, parked (by name, or once woken from the queue),
-- or running under a lease that has ended.
CREATE FUNCTION gov._claimable(p_run uuid, p_from_queue boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (SELECT FROM app.runs r WHERE r.workspace_id = sec.current_workspace() AND r.id = p_run
    AND (r.status = 'queued'
         OR (r.status = 'waiting' AND (r.woken OR NOT p_from_queue))
         OR (r.status = 'running' AND r.lease_expires_at <= clock_timestamp())))
$$;
