-- Unregister a piece. Refused while any effect it carried is UNKNOWN or still being sent: nobody can
-- yet say what it did. Otherwise its runs stop, its effects not yet sent are cancelled, and work
-- bound to it is refused from then on. Only the workspace's owner or an admin unregisters, never a
-- run. Returns false when it was already unregistered.
CREATE OR REPLACE FUNCTION gov.unregister_piece(p_piece uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  old_person text:=coalesce(current_setting('backbone.principal',true),''); old_run text:=coalesce(current_setting('backbone.run',true),''); old_secret text:=coalesce(current_setting('backbone.secret',true),'');
  ws uuid := sec.current_workspace();
  me uuid := sec.current_principal();
  p record;
  r record;
  e record;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no_identity: the session acts as nobody';
  END IF;
  IF sec.names_run() THEN
    RAISE EXCEPTION 'not_by_runs: a piece is unregistered by the person or an admin';
  END IF;
  IF sec.principal_kind(me) IS DISTINCT FROM 'person' OR NOT sec.is_admin(me) THEN
    RAISE EXCEPTION 'role: only the workspace''s owner or an admin unregisters a piece';
  END IF;
  PERFORM gov._lock_workspace();
  SELECT * INTO p FROM app.pieces x WHERE x.workspace_id = ws AND x.id = p_piece;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such piece in this workspace';
  END IF;
  IF p.unregistered_at IS NOT NULL THEN
    RETURN false;
  END IF;
  PERFORM set_config('backbone.run','',true); PERFORM set_config('backbone.secret','',true); PERFORM set_config('backbone.principal',sec.system_principal()::text,true);
  IF EXISTS (SELECT FROM app.effects x JOIN app.runs y ON y.workspace_id = x.workspace_id AND y.id = x.run_id
             WHERE x.workspace_id = ws AND y.piece_id = p_piece AND x.status IN ('unknown', 'dispatching')) THEN
    RAISE EXCEPTION 'unsettled: an effect this piece carried is UNKNOWN or still being sent; settle it first';
  END IF;
  UPDATE app.pieces SET unregistered_at = clock_timestamp(), unregistered_by = me WHERE workspace_id = ws AND id = p_piece;
  FOR r IN SELECT id FROM app.runs x WHERE x.workspace_id = ws AND x.piece_id = p_piece AND x.status IN ('queued', 'running', 'waiting') LOOP
    PERFORM gov._stop_run(r.id, 'cancelled', 'piece unregistered');
  END LOOP;
  FOR e IN SELECT x.id FROM app.effects x JOIN app.runs y ON y.workspace_id = x.workspace_id AND y.id = x.run_id
           WHERE x.workspace_id = ws AND y.piece_id = p_piece AND x.status IN ('proposed', 'awaiting_checker', 'allowed', 'claimed') LOOP
    PERFORM gov._cancel_effect(e.id, 'piece unregistered');
  END LOOP;
  PERFORM gov._append('piece.unregistered', p_piece::text, jsonb_build_object('piece', p.piece, 'digest', p.digest),me);
  PERFORM set_config('backbone.principal',old_person,true); PERFORM set_config('backbone.run',old_run,true); PERFORM set_config('backbone.secret',old_secret,true);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('backbone.principal',old_person,true); PERFORM set_config('backbone.run',old_run,true); PERFORM set_config('backbone.secret',old_secret,true);
  RAISE;
END
$$;
