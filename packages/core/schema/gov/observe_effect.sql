-- The dispatcher observes what came of a dispatch, under the claim it began with. An outcome it
-- cannot tell is UNKNOWN: never success, never resent, and given at once a named resolver (the
-- person the effect was for), its evidence (the observation hash) and a deadline 24 hours on
-- (I-6). The one exception to "observed once" is a late observation of a swept dispatch.
CREATE FUNCTION gov.observe_effect(p_effect uuid, p_claim text, p_outcome text, p_external_ref text, p_observation_hash text, p_note text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  e record;
  q record;
  resolver uuid;
BEGIN
  PERFORM gov._system();
  PERFORM gov._lock_workspace();
  SELECT * INTO e FROM app.effects x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_effect FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such effect in this workspace';
  END IF;
  SELECT * INTO q FROM ops.effect_queue x WHERE x.effect_id = p_effect;
  -- A late observation: the sweep recorded this dispatch UNKNOWN after its claim lapsed
  -- (gov.settle_lapsed_dispatch), and the dispatcher that held that claim now knows what came of it.
  -- It may settle it once, as succeeded or failed, never resend. Its claim is checked by hash.
  IF e.status = 'unknown' AND e.swept_claim_hash IS NOT NULL THEN
    IF e.swept_claim_hash IS DISTINCT FROM encode(sha256(convert_to(coalesce(p_claim, ''), 'UTF8')), 'hex') THEN
      RAISE EXCEPTION 'stale: this claim did not begin the dispatch';
    END IF;
    IF p_outcome IS NULL OR p_outcome NOT IN ('succeeded', 'failed') THEN
      RAISE EXCEPTION 'invalid: a late observation settles as succeeded or failed';
    END IF;
    UPDATE app.effects SET status = p_outcome, external_ref = coalesce(p_external_ref, external_ref), observation_hash = p_observation_hash,
                           note = p_note, settled_by = sec.current_principal(), swept_claim_hash = NULL
    WHERE workspace_id = e.workspace_id AND id = p_effect;
    PERFORM gov._append('effect.observed', p_effect::text, gov._effect_payload(p_effect) || jsonb_build_object(
      'outcome', p_outcome, 'external_ref', p_external_ref, 'dispatcher', sec.current_principal(), 'late', true,
      'note', sec.digest(p_note)));
    RETURN p_outcome;
  END IF;
  IF e.status <> 'dispatching' OR q.claim_token IS DISTINCT FROM p_claim THEN
    RAISE EXCEPTION 'stale: this claim did not begin the dispatch';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('succeeded', 'failed', 'unknown') THEN
    RAISE EXCEPTION 'invalid: an outcome is succeeded, failed or unknown';
  END IF;
  IF p_outcome = 'unknown' THEN
    resolver := coalesce(e.on_behalf_of_id, (SELECT p.id FROM app.principals p WHERE p.workspace_id = e.workspace_id
                                                AND p.kind = 'person' AND p.role = 'owner' ORDER BY p.created_at LIMIT 1));
  END IF;
  UPDATE app.effects SET status = p_outcome, external_ref = p_external_ref, observation_hash = p_observation_hash, note = p_note,
                         resolver_id = resolver, resolve_by = CASE WHEN p_outcome = 'unknown' THEN clock_timestamp() + interval '24 hours' END
  WHERE workspace_id = e.workspace_id AND id = p_effect;
  DELETE FROM ops.effect_queue x WHERE x.effect_id = p_effect;
  PERFORM gov._append('effect.observed', p_effect::text, gov._effect_payload(p_effect) || jsonb_build_object(
    'outcome', p_outcome, 'external_ref', p_external_ref, 'dispatcher', sec.current_principal(),
    'resolver', resolver, 'note', sec.digest(p_note)));
  RETURN p_outcome;
END
$$;
