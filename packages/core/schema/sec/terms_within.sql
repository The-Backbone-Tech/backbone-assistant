-- The kernel's isWithin: `child` grants nothing that `parent` does not.
CREATE FUNCTION sec.terms_within(child jsonb, parent jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$
  SELECT sec.set_within(child -> 'projects', parent -> 'projects')
     AND sec.set_within(child -> 'connections', parent -> 'connections')
     AND sec.set_within(child -> 'tools', parent -> 'tools')
     AND sec.set_within(child -> 'operations', parent -> 'operations')
     AND (child ->> 'ceiling')::int <= (parent ->> 'ceiling')::int
     AND (child ->> 'expiresAt')::bigint <= (parent ->> 'expiresAt')::bigint
     AND NOT EXISTS (
       SELECT FROM unnest(ARRAY['maxTokens', 'maxCostMicros', 'maxDurationMs', 'maxEffects']) k
       WHERE parent -> 'budget' ->> k IS NOT NULL
         AND (child -> 'budget' ->> k IS NULL OR (child -> 'budget' ->> k)::numeric > (parent -> 'budget' ->> k)::numeric))
$$;
