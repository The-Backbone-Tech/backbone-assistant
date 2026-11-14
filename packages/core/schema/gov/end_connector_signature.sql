-- Terminal and idempotent. A retry records no second end and never changes its original reason.
CREATE FUNCTION gov.end_connector_signature(p_signature uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  me uuid;
  s record;
BEGIN
  IF sec.names_run() THEN RAISE EXCEPTION 'not_by_runs: a run never ends a signature'; END IF;
  me := gov._person();
  PERFORM gov._lock_workspace();
  IF p_reason IS NULL OR p_reason NOT IN ('person_revoked','definition_changed','connection_removed','home_moved','superseded') THEN
    RAISE EXCEPTION 'invalid: unknown signature end reason';
  END IF;
  SELECT x.* INTO s FROM app.connector_signatures x WHERE x.workspace_id=sec.current_workspace() AND x.id=p_signature;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found: no such signature in this workspace'; END IF;
  IF s.person_id IS DISTINCT FROM me THEN RAISE EXCEPTION 'someone_else: only its person ends a signature'; END IF;
  IF s.ended_at IS NOT NULL THEN RETURN; END IF;
  UPDATE app.connector_signatures SET ended_at=clock_timestamp(),end_reason=p_reason
    WHERE workspace_id=sec.current_workspace() AND id=p_signature;
  PERFORM gov._append('signature.ended',p_signature::text,jsonb_build_object('signature',p_signature,'reason',p_reason),me);
END
$$;
