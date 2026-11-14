-- A person accepts an imported memory (then it is their memory, in their words) or declines it.
CREATE FUNCTION gov.decide_memory_proposal(p_proposal uuid, p_accept boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := gov._person('not_by_runs');
  p record;
  memory uuid;
BEGIN
  SELECT * INTO p FROM app.memory_proposals x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_proposal AND x.status = 'open';
  IF NOT FOUND OR p.person_id <> me THEN
    RAISE EXCEPTION 'not_found: no such open proposal of this person';
  END IF;
  IF p_accept THEN
    memory := gov.write_memory(me, NULL, p.content);
  END IF;
  UPDATE app.memory_proposals SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END, memory_id = memory
  WHERE workspace_id = p.workspace_id AND id = p_proposal;
  PERFORM gov._append('memory.proposal_decided', p_proposal::text, jsonb_build_object('accepted', p_accept, 'memory', memory));
  RETURN CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END;
END
$$;
