-- A worker process claims a run by its id. Only a worker claims: a session naming a principal or a
-- run is refused. Returns its fence and secret, or no row when its mandate no longer stands (the
-- run is then stopped). The worker states what it runs: 'piece' with the registered piece, or
-- 'direct'. A run is claimed only for exactly what carries it, so a piece never executes a direct
-- run or another piece's (or version's), and a direct worker never executes a piece's.
CREATE OR REPLACE FUNCTION gov.claim_run(p_run uuid, p_worker text, p_lease_ms integer, p_carrier text, p_piece uuid DEFAULT NULL) RETURNS TABLE (fence bigint, secret text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  c record;
  bound record;
BEGIN
  IF sec.current_workspace() IS NULL THEN
    RAISE EXCEPTION 'no_identity: the session names no workspace';
  END IF;
  IF nullif(current_setting('backbone.principal', true), '') IS NOT NULL OR sec.names_run() THEN
    RAISE EXCEPTION 'workers_only: runs are claimed by worker processes, not by principals or runs';
  END IF;
  IF p_carrier IS NULL OR NOT ((p_carrier = 'piece' AND p_piece IS NOT NULL) OR (p_carrier = 'direct' AND p_piece IS NULL)) THEN
    RAISE EXCEPTION 'invalid: a worker states what it runs: ''piece'' with a registered piece, or ''direct''';
  END IF;
  PERFORM set_config('backbone.principal',sec.system_principal()::text,true);
  -- Revocation takes workspace then run; claims must take the same order.
  PERFORM gov._lock_workspace();
  SELECT carrier, piece_id INTO bound FROM app.runs WHERE workspace_id = sec.current_workspace() AND id = p_run FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such run in this workspace';
  END IF;
  IF (bound.carrier, bound.piece_id) IS DISTINCT FROM (p_carrier, p_piece) THEN
    RAISE EXCEPTION 'other_piece: the run is carried by something other than what this worker runs';
  END IF;
  IF NOT gov._claimable(p_run, false) THEN
    RAISE EXCEPTION 'not_claimable: the run is held, finished or stopped';
  END IF;
  SELECT * INTO c FROM gov._claim(p_run, p_worker, p_lease_ms);
  PERFORM set_config('backbone.principal','',true);
  IF c.fence IS NOT NULL THEN
    RETURN QUERY SELECT c.fence, c.secret;
  END IF;
END
$$;
