-- Whether `p_checker` may check `p_proposer`'s proposal. Strictly: from outside every delegation
-- tree the proposer takes part in, people included. Leniently: anyone but the proposer itself and
-- the agents it owns.
CREATE FUNCTION sec.checker_independent(p_workspace uuid, p_proposer uuid, p_checker uuid, p_strict boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT p_checker IS NOT NULL AND p_checker <> p_proposer AND CASE
    WHEN p_strict THEN NOT EXISTS (SELECT FROM sec.delegation_tree(p_workspace, p_proposer) t WHERE t = p_checker)
    ELSE NOT EXISTS (SELECT FROM app.principals
                     WHERE workspace_id = p_workspace AND id = p_checker AND kind = 'agent' AND owner_id = p_proposer)
  END
$$;
