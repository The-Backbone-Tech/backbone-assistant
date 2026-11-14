-- True when the set-spec `child` covers nothing that `parent` does not.
CREATE FUNCTION sec.set_within(child jsonb, parent jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$
  SELECT parent = '"*"'
      OR (child <> '"*"' AND NOT EXISTS (SELECT FROM jsonb_array_elements_text(child) x WHERE NOT parent ? x))
$$;
