-- Whether a mandate still stands: 'ok', or why not. A budget is charged to every ancestor, so a
-- child cannot reset its root's limit: each ancestor's limit counts everything spent beneath it.
CREATE FUNCTION gov._mandate_standing(p_mandate uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  m record;
  a record;
  tokens numeric;
  cost numeric;
  effects bigint;
BEGIN
  SELECT * INTO m FROM app.mandates WHERE workspace_id = sec.current_workspace() AND id = p_mandate;
  IF NOT FOUND OR m.revoked_at IS NOT NULL THEN
    RETURN 'mandate_revoked';
  END IF;
  IF m.expires_at <= clock_timestamp() THEN
    RETURN 'mandate_expired';
  END IF;
  FOR a IN SELECT x.* FROM app.mandates x WHERE x.workspace_id = m.workspace_id AND x.id IN (SELECT gov._ancestors(p_mandate)) LOOP
    IF a.revoked_at IS NOT NULL THEN
      RETURN 'mandate_revoked';
    END IF;
    IF a.max_tokens IS NULL AND a.max_cost_micros IS NULL AND a.max_effects IS NULL THEN
      CONTINUE;
    END IF;
    SELECT coalesce(sum(r.tokens_used), 0), coalesce(sum(r.cost_micros), 0) INTO tokens, cost
    FROM app.runs r WHERE r.workspace_id = a.workspace_id AND r.mandate_id IN (SELECT gov._subtree(a.id));
    SELECT count(*) INTO effects FROM app.effects e
    WHERE e.workspace_id = a.workspace_id AND e.mandate_id IN (SELECT gov._subtree(a.id)) AND e.status NOT IN ('denied', 'cancelled');
    IF (a.max_tokens IS NOT NULL AND tokens >= a.max_tokens) OR (a.max_cost_micros IS NOT NULL AND cost >= a.max_cost_micros)
       OR (a.max_effects IS NOT NULL AND effects >= a.max_effects) THEN
      RETURN 'budget_exhausted';
    END IF;
  END LOOP;
  RETURN 'ok';
END
$$;
