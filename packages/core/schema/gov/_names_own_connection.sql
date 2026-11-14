-- Whether a set-spec of connections, tools or operations names a person's own connection: by its
-- slug, as `<slug>__tool`, or as `mcp.<slug>.operation`. A mandate is read by every member, so it
-- never does.
CREATE FUNCTION gov._names_own_connection(p_spec jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT jsonb_typeof(p_spec) = 'array' AND EXISTS (
    SELECT FROM jsonb_array_elements_text(p_spec) x
    JOIN app.connections c ON c.workspace_id = sec.current_workspace() AND c.scope = 'person'
    WHERE x = c.slug OR x LIKE c.slug || '\_\_%' OR x LIKE 'mcp.' || c.slug || '.%')
$$;
