-- What two set-specs both cover ('*' is everything the other covers), sorted and without repeats.
CREATE FUNCTION sec.set_intersect(a jsonb, b jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN a = '"*"' AND b = '"*"' THEN '"*"'::jsonb
    ELSE coalesce((
      SELECT jsonb_agg(x ORDER BY x COLLATE "C") FROM (
        SELECT DISTINCT x FROM jsonb_array_elements_text(CASE WHEN a = '"*"' THEN b ELSE a END) x
        WHERE (CASE WHEN a = '"*"' THEN a ELSE b END) = '"*"'
           OR (CASE WHEN a = '"*"' THEN a ELSE b END) ? x) d
    ), '[]'::jsonb)
  END
$$;
