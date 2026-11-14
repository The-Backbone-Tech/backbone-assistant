-- Source eligibility is independent of the audience of the person answering a kept candidate.
CREATE FUNCTION gov._promotion_sources_allowed(p_candidate uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (SELECT FROM gov.eligible_knowledge_sources WHERE candidate_id=p_candidate)
$$;
