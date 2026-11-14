-- Another agent's store, by the name people know it under.
CREATE FUNCTION gov._source_name(p_source text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $$ SELECT CASE p_source WHEN 'openclaw' THEN 'OpenClaw' WHEN 'hermes' THEN 'Hermes' ELSE p_source END $$;
