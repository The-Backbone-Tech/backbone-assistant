-- A reason as the material itself: an earlier run's carried or quoted reason is passed on as what it read.
CREATE FUNCTION gov._strip_carried(p_reason text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $$ SELECT regexp_replace(p_reason, '^(earlier work in this task|other work it quoted), which (had )?read ', '') $$;
