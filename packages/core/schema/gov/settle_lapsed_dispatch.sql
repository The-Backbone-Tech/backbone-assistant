-- The system principal settles a dispatch whose dispatcher went silent (effect-gateway contract, stale dispatch), by
-- inspection, never by sending it again. Decided by the effect's own dispatch claim alone: only once
-- that claim's lease and the 30-second grace window have passed, checked and marked in this one
-- crossing under the effect's lock, so a dispatcher observing at the same moment cannot interleave.
-- A run's lease or status says nothing here. Returns 'live' (left alone), 'succeeded' (the
-- inspection found it landed) or 'unknown' (with its resolver and deadline, I-6). The
-- closed claim's hash is kept: a late observation under it may still settle the UNKNOWN.
CREATE FUNCTION gov.settle_lapsed_dispatch(p_effect uuid, p_claim text, p_landed boolean, p_observation_hash text, p_note text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  grace constant interval := interval '30 seconds';
  e record;
  q record;
  outcome text;
  resolver uuid;
BEGIN
  PERFORM gov._system();
  PERFORM gov._lock_workspace();
  SELECT * INTO e FROM app.effects x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_effect FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such effect in this workspace';
  END IF;
  SELECT * INTO q FROM ops.effect_queue x WHERE x.effect_id = p_effect FOR UPDATE;
  IF e.status <> 'dispatching' OR q.claim_token IS DISTINCT FROM p_claim THEN
    RAISE EXCEPTION 'stale: this claim does not hold a dispatch in flight';
  END IF;
  IF p_landed IS NULL OR p_observation_hash IS NULL THEN
    RAISE EXCEPTION 'invalid: a settlement states whether it landed and its evidence';
  END IF;
  IF q.lease_expires_at + grace > clock_timestamp() OR (q.stale_handed_until IS NOT NULL AND q.stale_handed_until > clock_timestamp()) THEN
    RETURN 'live';
  END IF;
  outcome := CASE WHEN p_landed THEN 'succeeded' ELSE 'unknown' END;
  IF outcome = 'unknown' THEN
    resolver := coalesce(e.on_behalf_of_id, (SELECT p.id FROM app.principals p WHERE p.workspace_id = e.workspace_id
                                                AND p.kind = 'person' AND p.role = 'owner' ORDER BY p.created_at LIMIT 1));
  END IF;
  UPDATE app.effects SET status = outcome, observation_hash = p_observation_hash, note = p_note, resolver_id = resolver,
                         resolve_by = CASE WHEN outcome = 'unknown' THEN clock_timestamp() + interval '24 hours' END,
                         swept_claim_hash = CASE WHEN outcome = 'unknown' THEN encode(sha256(convert_to(p_claim, 'UTF8')), 'hex') END
  WHERE workspace_id = e.workspace_id AND id = p_effect;
  DELETE FROM ops.effect_queue x WHERE x.effect_id = p_effect;
  PERFORM gov._append('effect.observed', p_effect::text, gov._effect_payload(p_effect) || jsonb_build_object(
    'outcome', outcome, 'dispatcher', sec.current_principal(), 'resolver', resolver, 'swept', true, 'note', sec.digest(p_note)));
  RETURN outcome;
END
$$;
