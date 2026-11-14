-- Every principal in the delegation trees the principal takes part in: the trees of every mandate
-- that names it (as issuer, subject or beneficiary), from their roots down, plus the owner of an
-- agent and the agents a person owns. Read under the wall of `p_workspace`.
CREATE FUNCTION sec.delegation_tree(p_workspace uuid, p_principal uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  WITH RECURSIVE
  up AS (
    SELECT m.id, m.parent_id FROM app.mandates m
    WHERE m.workspace_id = p_workspace AND p_principal IN (m.issuer_id, m.subject_id, m.on_behalf_of_id)
    UNION
    SELECT m.id, m.parent_id FROM app.mandates m JOIN up ON m.workspace_id = p_workspace AND m.id = up.parent_id
  ),
  down AS (
    SELECT id FROM up WHERE parent_id IS NULL
    UNION
    SELECT m.id FROM app.mandates m JOIN down ON m.workspace_id = p_workspace AND m.parent_id = down.id
  ),
  named AS (
    SELECT unnest(ARRAY[m.issuer_id, m.subject_id, m.on_behalf_of_id]) AS principal
    FROM app.mandates m JOIN down ON m.workspace_id = p_workspace AND m.id = down.id
    UNION SELECT p_principal
    UNION SELECT owner_id FROM app.principals WHERE workspace_id = p_workspace AND id = p_principal AND kind = 'agent'
    UNION SELECT id FROM app.principals WHERE workspace_id = p_workspace AND owner_id = p_principal AND kind = 'agent'
  )
  SELECT DISTINCT principal FROM named WHERE principal IS NOT NULL
$$;
