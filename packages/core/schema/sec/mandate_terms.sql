-- A stored mandate (as jsonb) in the kernel's terms: set-specs, ceiling, budget, and expiry in
-- milliseconds since the epoch.
CREATE FUNCTION sec.mandate_terms(m jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'projects', m -> 'projects', 'connections', m -> 'connections', 'tools', m -> 'tools', 'operations', m -> 'operations',
    'ceiling', (m ->> 'ceiling')::int,
    'budget', jsonb_build_object('maxTokens', (m ->> 'max_tokens')::bigint, 'maxCostMicros', (m ->> 'max_cost_micros')::bigint,
                                 'maxDurationMs', (m ->> 'max_duration_ms')::bigint, 'maxEffects', (m ->> 'max_effects')::bigint),
    'expiresAt', floor(extract(epoch FROM (m ->> 'expires_at')::timestamptz) * 1000)::bigint)
$$;
