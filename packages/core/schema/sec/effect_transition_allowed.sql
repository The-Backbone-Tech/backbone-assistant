-- The effect lifecycle, as the kernel's EFFECT_TRANSITIONS states it.
CREATE FUNCTION sec.effect_transition_allowed(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$
  SELECT coalesce(p_to = ANY (CASE p_from
    WHEN 'proposed' THEN ARRAY['allowed', 'awaiting_checker', 'denied', 'cancelled']
    WHEN 'awaiting_checker' THEN ARRAY['allowed', 'denied', 'cancelled']
    WHEN 'allowed' THEN ARRAY['claimed', 'cancelled']
    WHEN 'claimed' THEN ARRAY['dispatching', 'allowed', 'cancelled']
    WHEN 'dispatching' THEN ARRAY['succeeded', 'failed', 'unknown']
    WHEN 'unknown' THEN ARRAY['succeeded', 'failed']
    ELSE ARRAY[]::text[]
  END), false)
$$;
