-- The gateway's hash of an effect's arguments: SHA-256 of the canonical text of the jsonb value
-- (keys ordered as jsonb orders them), as lowercase hex. A checker approves exactly this hash.
CREATE FUNCTION sec.args_hash(p_args jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$ SELECT encode(sha256(convert_to(p_args::text, 'UTF8')), 'hex') $$;
