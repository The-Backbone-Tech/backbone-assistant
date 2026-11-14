-- The kernel's attenuate: exactly what was requested and what the parent holds.
CREATE FUNCTION sec.attenuate(parent jsonb, requested jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'projects', sec.set_intersect(parent -> 'projects', requested -> 'projects'),
    'connections', sec.set_intersect(parent -> 'connections', requested -> 'connections'),
    'tools', sec.set_intersect(parent -> 'tools', requested -> 'tools'),
    'operations', sec.set_intersect(parent -> 'operations', requested -> 'operations'),
    'ceiling', least((parent ->> 'ceiling')::int, (requested ->> 'ceiling')::int),
    'budget', (
      SELECT jsonb_object_agg(k, CASE
        WHEN parent -> 'budget' ->> k IS NULL THEN requested -> 'budget' -> k
        WHEN requested -> 'budget' ->> k IS NULL THEN parent -> 'budget' -> k
        ELSE to_jsonb(least((parent -> 'budget' ->> k)::numeric, (requested -> 'budget' ->> k)::numeric)) END)
      FROM unnest(ARRAY['maxTokens', 'maxCostMicros', 'maxDurationMs', 'maxEffects']) k),
    'expiresAt', least((parent ->> 'expiresAt')::bigint, (requested ->> 'expiresAt')::bigint))
$$;
