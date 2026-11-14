-- A person connects a first-party server profile Backbone knows (its reads are classed by Backbone,
-- never by the model): their own, or as an owner or admin the workspace's.
CREATE FUNCTION gov.register_first_party_connection(p_profile text, p_slug text, p_scope text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  new_id uuid;
BEGIN
  IF p_profile IS NULL OR NOT EXISTS (SELECT FROM gov._profile_reads() pr WHERE pr.profile = p_profile) THEN
    RAISE EXCEPTION 'invalid: no such first-party profile';
  END IF;
  new_id := gov.register_connection(p_profile, p_slug, NULL, p_scope, 'oauth');
  UPDATE app.connections SET profile = p_profile WHERE workspace_id = sec.current_workspace() AND id = new_id;
  RETURN new_id;
END
$$;
