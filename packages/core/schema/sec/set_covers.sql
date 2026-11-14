-- True when a set-spec covers one identifier.
CREATE FUNCTION sec.set_covers(spec jsonb, id text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$ SELECT spec = '"*"' OR spec ? id $$;
