-- The claims the workspace's dispatcher holds on effects still claimed or dispatching, for the
-- system principal alone (a claim is worth nothing to anyone else): what a dispatcher restarted
-- after a kill needs to observe its interrupted dispatches, never to send them again.
CREATE FUNCTION gov.held_claims() RETURNS TABLE (effect_id uuid, status text, claim_token text, args jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  PERFORM gov._system();
  RETURN QUERY SELECT e.id, e.status, q.claim_token, e.args FROM app.effects e
    JOIN ops.effect_queue q ON q.effect_id = e.id
    WHERE e.workspace_id = sec.current_workspace() AND e.status IN ('claimed', 'dispatching') AND q.claim_token IS NOT NULL
    ORDER BY e.created_at;
END
$$;
