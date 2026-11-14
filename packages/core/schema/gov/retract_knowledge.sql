-- Retract accepted knowledge, once, with a reason kept on the knowledge (the ledger holds its
-- digest): its exact owner, whatever their role now, or a current owner or admin.
CREATE FUNCTION gov.retract_knowledge(p_knowledge uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := gov._person();
  k record;
BEGIN
  SELECT * INTO k FROM app.knowledge x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_knowledge FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such knowledge in this workspace';
  END IF;
  IF k.owner_id <> me AND NOT sec.is_admin(me) THEN
    RAISE EXCEPTION 'role: knowledge is retracted by its owner or an admin';
  END IF;
  IF k.status <> 'accepted' THEN
    RAISE EXCEPTION 'not_open: the knowledge is already retracted';
  END IF;
  IF p_reason IS NULL OR length(p_reason) = 0 THEN
    RAISE EXCEPTION 'invalid: a retraction gives its reason';
  END IF;
  UPDATE app.knowledge SET status = 'retracted', retracted_reason = p_reason, retracted_by = me, retracted_at = clock_timestamp()
  WHERE workspace_id = k.workspace_id AND id = p_knowledge;
  PERFORM gov._append('knowledge.retracted', p_knowledge::text, jsonb_build_object('reason', sec.digest(p_reason)));
  RETURN p_knowledge;
END
$$;
