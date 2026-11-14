-- Return a set once per policy query; never expose another audience's candidate identifiers.
CREATE FUNCTION sec.visible_eligible_knowledge_sources() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT source.candidate_id FROM gov.eligible_knowledge_sources source
  WHERE sec.candidate_visible(source.candidate_id)
$$;
