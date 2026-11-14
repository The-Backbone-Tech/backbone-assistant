-- The identifiers a digest's quotes name under one kind: only strings, only when the kind is a list.
CREATE FUNCTION gov._quoted_ids(p_quotes jsonb, p_kind text) RETURNS SETOF text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $$
  SELECT x FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_quotes -> p_kind) = 'array' THEN p_quotes -> p_kind ELSE '[]' END) x
  WHERE x ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;
