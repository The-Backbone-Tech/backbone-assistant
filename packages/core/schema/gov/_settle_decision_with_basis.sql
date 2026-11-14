-- Approval recheck insertion point: immediately before the decision UPDATE below, after reading d.
-- A future shared recheck must be called here AND by gov._settle_decision before either consumes approval.
-- Record an answer and carry it out on its subject: an approved effect is let through (after the
-- workspace's window if it is delayable) and a rejected one denied; an approved promotion accepts
-- the knowledge inside this same answer; an approved catalogue change applies. A run parked on
-- the question wakes.
CREATE FUNCTION gov._settle_decision_with_basis(p_decision uuid, p_verdict text, p_by uuid, p_note text, p_basis jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  d record;
  e record;
BEGIN
  SELECT * INTO d FROM app.decisions x WHERE x.workspace_id = ws AND x.id = p_decision;
  UPDATE app.decisions SET status = p_verdict, answered_by = p_by, answered_at = clock_timestamp(), note = p_note
  WHERE workspace_id = ws AND id = p_decision;
  DELETE FROM ops.verification_queue x WHERE x.decision_id = p_decision;
  PERFORM gov._append('decision.answered', p_decision::text, jsonb_build_object(
    'verdict', p_verdict, 'subject', d.subject_id, 'note', sec.digest(p_note), 'basis', p_basis), p_by);
  IF d.subject_kind = 'effect' THEN
    SELECT * INTO e FROM app.effects x WHERE x.workspace_id = ws AND x.id = d.subject_id FOR UPDATE;
    IF e.status = 'awaiting_checker' THEN
      IF p_verdict = 'approved' THEN
        UPDATE app.effects SET status = 'allowed',
          not_before = CASE WHEN e.effect_class = 4 THEN clock_timestamp() + make_interval(secs =>
                         (SELECT w.delay_window_ms FROM app.workspaces w WHERE w.id = ws) / 1000.0) END
        WHERE workspace_id = ws AND id = e.id;
        PERFORM gov._enqueue_effect(e.id);
      ELSE
        UPDATE app.effects SET status = 'denied' WHERE workspace_id = ws AND id = e.id;
      END IF;
    END IF;
    IF e.run_id IS NOT NULL THEN
      PERFORM gov._wake_run(e.run_id);
    END IF;
  ELSIF d.subject_kind = 'promotion' THEN
    IF p_verdict = 'approved' THEN
      PERFORM gov._promote(d.subject_id, p_decision, p_by);
    ELSE
      UPDATE app.knowledge_candidates SET status = 'rejected' WHERE workspace_id = ws AND id = d.subject_id;
    END IF;
  ELSIF d.subject_kind = 'elevation' THEN
    IF p_verdict = 'approved' THEN
      PERFORM gov._apply_classification(d.subject_id);
    ELSE
      UPDATE app.operation_changes SET status = 'rejected' WHERE workspace_id = ws AND id = d.subject_id;
    END IF;
  END IF;
END
$$;
