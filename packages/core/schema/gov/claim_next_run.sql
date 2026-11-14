-- A worker takes the next claimable run of any workspace, from an empty session, and leaves the
-- session empty again. Runs whose mandate no longer stands are stopped on the way, not handed out.
-- Only runs carried by exactly what the worker runs ('piece' with p_piece, or 'direct') are handed to it.
CREATE FUNCTION gov.claim_next_run(p_worker text, p_lease_ms integer, p_carrier text, p_piece uuid DEFAULT NULL)
RETURNS TABLE (workspace_id uuid, run_id uuid, fence bigint, secret text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  q record;
  r record;
  c record;
  busy_workspaces uuid[] := '{}';
  wanted text := CASE WHEN p_carrier = 'piece' AND p_piece IS NOT NULL THEN p_piece::text WHEN p_carrier = 'direct' AND p_piece IS NULL THEN 'direct' END;
BEGIN
  IF NOT sec.session_is_empty() THEN
    RAISE EXCEPTION 'empty_session_only: the queue is read from a session that names nobody';
  END IF;
  IF wanted IS NULL THEN
    RAISE EXCEPTION 'invalid: a worker states what it runs: ''piece'' with a registered piece, or ''direct''';
  END IF;
  LOOP
    -- Select without a queue/run lock, bind its workspace for RLS, then lock workspace first.
    SELECT x.* INTO q FROM ops.run_queue x
    WHERE x.carrier_key = wanted AND x.claimable_after <= clock_timestamp()
      AND NOT (x.workspace_id = ANY(busy_workspaces))
    ORDER BY x.claimable_after, x.enqueued_at LIMIT 1;
    EXIT WHEN NOT FOUND;
    PERFORM set_config('backbone.workspace', q.workspace_id::text, true);
    PERFORM 1 FROM app.ledger_heads WHERE workspace_id = q.workspace_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      busy_workspaces := array_append(busy_workspaces, q.workspace_id);
      PERFORM set_config('backbone.workspace', '', true);
      CONTINUE;
    END IF;
    SELECT * INTO r FROM app.runs x WHERE x.workspace_id = q.workspace_id AND x.id = q.run_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      UPDATE ops.run_queue SET claimable_after = clock_timestamp() + interval '1 second' WHERE ops.run_queue.run_id = q.run_id;
    ELSIF r.status NOT IN ('queued', 'running', 'waiting') THEN
      DELETE FROM ops.run_queue WHERE ops.run_queue.run_id = q.run_id;
    ELSIF r.status = 'waiting' AND NOT r.woken THEN
      UPDATE ops.run_queue SET claimable_after = NULL WHERE ops.run_queue.run_id = q.run_id;
    ELSIF r.status = 'running' AND r.lease_expires_at > clock_timestamp() THEN
      UPDATE ops.run_queue SET claimable_after = r.lease_expires_at WHERE ops.run_queue.run_id = q.run_id;
    ELSE
      SELECT * INTO c FROM gov._claim(q.run_id, p_worker, p_lease_ms);
      IF c.fence IS NOT NULL THEN
        PERFORM set_config('backbone.workspace', '', true);
        RETURN QUERY SELECT q.workspace_id, q.run_id, c.fence, c.secret;
        RETURN;
      END IF;
    END IF;
    PERFORM set_config('backbone.workspace', '', true);
  END LOOP;
  PERFORM set_config('backbone.workspace', '', true);
END
$$;
