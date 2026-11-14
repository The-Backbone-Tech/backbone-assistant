-- Whether the session may answer the question (with an approval): the same rule the answer applies.
CREATE FUNCTION gov.may_decide(p_decision uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := sec.current_principal();
BEGIN
  IF me IS NULL OR sec.names_run() THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT FROM app.decisions d WHERE d.workspace_id = sec.current_workspace() AND d.id = p_decision
             AND d.subject_kind = 'promotion' AND NOT gov._promotion_sources_allowed(d.subject_id)) THEN
    RETURN false;
  END IF;
  IF sec.is_verifier(me) THEN
    RETURN EXISTS (SELECT FROM app.decisions d WHERE d.workspace_id = sec.current_workspace() AND d.id = p_decision
                   AND d.status = 'open' AND d.checker_kind = 'verifier');
  END IF;
  BEGIN
    PERFORM gov._may_answer(p_decision, me, 'approved');
    RETURN true;
  EXCEPTION WHEN raise_exception THEN
    RETURN false;
  END;
END
$$;
