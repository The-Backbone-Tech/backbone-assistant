-- One temporary source-eligibility rule, computed from immutable Core evidence and ledger order.
-- Private to the governor. Public access goes through the audience-filtered set-returning helper.
CREATE VIEW gov.eligible_knowledge_sources AS
WITH permitted_kind(kind) AS (VALUES ('message'::text),('web'::text)),
citation_proof AS (
  SELECT candidate.workspace_id, candidate.id,
    bool_and(source.id IS NOT NULL AND source.source_kind IN (SELECT kind FROM permitted_kind)) AS allowed
  FROM app.knowledge_candidates candidate
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(candidate.evidence)='array' THEN candidate.evidence ELSE '[]'::jsonb END) citation
  LEFT JOIN app.episodes source ON source.workspace_id=candidate.workspace_id
    AND source.id=CASE WHEN citation->>'episode' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (citation->>'episode')::uuid END
  WHERE candidate.workspace_id=sec.current_workspace()
  GROUP BY candidate.workspace_id,candidate.id
)
SELECT c.workspace_id, c.id AS candidate_id
FROM app.knowledge_candidates c
JOIN citation_proof citations ON citations.workspace_id=c.workspace_id AND citations.id=c.id AND citations.allowed
JOIN app.principals proposer ON proposer.workspace_id=c.workspace_id AND proposer.id=c.proposed_by
LEFT JOIN (
  SELECT workspace_id, subject, min(seq) AS seq, count(*) AS entries
  FROM app.ledger WHERE entry_type='knowledge.proposed'
  GROUP BY workspace_id, subject
) proposal ON proposal.workspace_id=c.workspace_id AND proposal.subject=c.id::text
WHERE c.workspace_id=sec.current_workspace()
  AND jsonb_typeof(c.evidence)='array'
  AND jsonb_array_length(CASE WHEN jsonb_typeof(c.evidence)='array' THEN c.evidence ELSE '[]'::jsonb END)>0
  AND (c.run_id IS NOT NULL OR proposer.kind IN ('person','system'))
  AND (c.run_id IS NULL OR (proposal.entries=1 AND NOT EXISTS (
    SELECT FROM app.episodes reading
    LEFT JOIN app.ledger record ON record.workspace_id=reading.workspace_id
      AND record.subject=reading.id::text AND record.entry_type='source.recorded'
    WHERE reading.workspace_id=c.workspace_id AND reading.run_id=c.run_id
      AND NOT EXISTS (SELECT FROM permitted_kind WHERE kind=reading.source_kind)
      AND (record.seq IS NULL OR record.seq<proposal.seq)
  )));
REVOKE ALL ON gov.eligible_knowledge_sources FROM PUBLIC, backbone_app;
