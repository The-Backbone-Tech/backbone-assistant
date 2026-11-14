-- A verifier worker takes the next question of any workspace's verification queue, from an empty
-- session, under a short lease, and leaves the session empty. Escalated, answered or withdrawn
-- questions leave the queue on the way.
CREATE FUNCTION gov.claim_next_verification(p_worker text, p_lease_ms integer)
RETURNS TABLE (workspace_id uuid, decision_id uuid, verifier_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  q record;
  d record;
  paused boolean;
  held uuid[] := ARRAY[]::uuid[];
BEGIN
  IF NOT sec.session_is_empty() THEN
    RAISE EXCEPTION 'empty_session_only: the queue is read from a session that names nobody';
  END IF;
  IF p_lease_ms IS NULL OR p_lease_ms <= 0 THEN
    RAISE EXCEPTION 'invalid: a lease is a positive number of milliseconds';
  END IF;
  LOOP
    SELECT * INTO q FROM ops.verification_queue x WHERE x.available_at <= clock_timestamp() AND NOT (x.decision_id = ANY(held))
    ORDER BY x.enqueued_at LIMIT 1 FOR UPDATE SKIP LOCKED;
    EXIT WHEN NOT FOUND;
    PERFORM set_config('backbone.workspace', q.workspace_id::text, true);
    SELECT * INTO d FROM app.decisions x WHERE x.workspace_id = q.workspace_id AND x.id = q.decision_id;
    paused := d.subject_kind = 'promotion' AND NOT gov._promotion_sources_allowed(d.subject_id);
    PERFORM set_config('backbone.workspace', '', true);
    IF paused THEN
      held := array_append(held, q.decision_id);
      CONTINUE;
    END IF;
    IF d.id IS NULL OR d.status <> 'open' OR d.escalated_at IS NOT NULL THEN
      DELETE FROM ops.verification_queue x WHERE x.decision_id = q.decision_id;
    ELSE
      UPDATE ops.verification_queue x SET available_at = clock_timestamp() + make_interval(secs => p_lease_ms / 1000.0), worker = p_worker
      WHERE x.decision_id = q.decision_id;
      RETURN QUERY SELECT q.workspace_id, q.decision_id, q.verifier_id;
      RETURN;
    END IF;
  END LOOP;
END
$$;
