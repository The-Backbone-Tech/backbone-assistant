-- Explicit project/directory/automation authority; never inferred from a renderer's identity.
CREATE FUNCTION gov.identity_directory_create(p_issuer text, p_subject text, p_username text, p_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
#variable_conflict use_column
DECLARE me uuid; person uuid:=gen_random_uuid(); ws uuid:=sec.current_workspace();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('identity:'||ws::text,17)); PERFORM gov._lock_workspace(); me:=gov._admin();
  IF nullif(p_issuer,'') IS NULL OR nullif(p_subject,'') IS NULL OR nullif(p_username,'') IS NULL THEN RAISE EXCEPTION 'invalid: directory account'; END IF;
  INSERT INTO app.principals(workspace_id,id,kind,role,name,user_id) VALUES(ws,person,'person','member',coalesce(nullif(p_name,''),p_username),person::text);
  INSERT INTO app.identity_accounts(workspace_id,principal_id,issuer,subject) VALUES(ws,person,p_issuer,p_subject);
  INSERT INTO app.identity_directory(workspace_id,principal_id,issuer,subject,user_name,display_name) VALUES(ws,person,p_issuer,p_subject,p_username,p_name);
  PERFORM gov._append('identity.provisioned',person::text,jsonb_build_object('by',me));
  RETURN person;
END
$$;
REVOKE ALL ON FUNCTION gov.identity_directory_create(text,text,text,text) FROM PUBLIC,backbone_operator;
GRANT EXECUTE ON FUNCTION gov.identity_directory_create(text,text,text,text) TO backbone_app;
