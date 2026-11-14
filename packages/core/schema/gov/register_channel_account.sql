-- An owner or admin connects a channel workspace (a Slack team, say).
CREATE FUNCTION gov.register_channel_account(p_platform text, p_team text, p_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := gov._admin('not_by_runs');
  new_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO app.channel_accounts (workspace_id, id, platform, team, name)
  VALUES (sec.current_workspace(), new_id, p_platform, p_team, coalesce(p_name, p_team));
  PERFORM gov._append('channel.account_registered', new_id::text, jsonb_build_object('platform', p_platform));
  RETURN new_id;
END
$$;
