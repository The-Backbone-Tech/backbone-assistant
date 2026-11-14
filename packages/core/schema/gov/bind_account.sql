-- A person binds their sign-in account, once.
CREATE FUNCTION gov.bind_account(p_user text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := gov._person();
BEGIN
  IF p_user IS NULL OR length(p_user) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid: an account id is needed';
  END IF;
  UPDATE app.principals SET user_id = p_user WHERE workspace_id = sec.current_workspace() AND id = me;
  PERFORM gov._append('person.account_bound', me::text, '{}');
  RETURN me;
END
$$;
