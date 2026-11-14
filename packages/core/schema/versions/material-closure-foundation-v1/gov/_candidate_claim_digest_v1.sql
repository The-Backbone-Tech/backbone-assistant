-- Material closure foundation v1. Canonical versioned source; see its closed manifest.
CREATE FUNCTION gov._candidate_claim_digest_v1(p_claim app.knowledge_candidates) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT sec.digest(jsonb_build_object(
    'version', 1,
    'workspace', (p_claim).workspace_id,
    'candidate', (p_claim).id,
    'statement', (p_claim).statement,
    'topic', (p_claim).topic,
    'evidence', (p_claim).evidence,
    'proposed_by', (p_claim).proposed_by,
    'run', (p_claim).run_id,
    'on_behalf_of', (p_claim).on_behalf_of,
    'words_untrusted', (p_claim).words_untrusted,
    'kept', (p_claim).kept,
    'created_at', to_char((p_claim).created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  )::text)
  WHERE (p_claim).workspace_id = sec.current_workspace()
$$;
REVOKE ALL ON FUNCTION gov._candidate_claim_digest_v1(app.knowledge_candidates)
  FROM PUBLIC, backbone_app, backbone_operator;
