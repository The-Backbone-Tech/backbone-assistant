-- The tools of a first-party connection profile that Backbone classes as reads (class 1, external).
-- A read is still routed by the rule of two on whatever arguments the model gives it.
CREATE FUNCTION gov._profile_reads() RETURNS TABLE (profile text, tool text)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $$
  SELECT * FROM (VALUES
    ('github', 'get_me'), ('github', 'get_file_contents'), ('github', 'get_repository_tree'), ('github', 'search_code'),
    ('github', 'search_issues'), ('google_gmail', 'search_threads'), ('google_gmail', 'get_thread')
  ) AS p (profile, tool)
$$;
