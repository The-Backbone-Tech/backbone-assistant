-- Ending is terminal even for direct writes by a role allowed to update the signature store.
CREATE FUNCTION sec.t_connector_signature_terminal() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL AND (NEW.ended_at,NEW.end_reason) IS DISTINCT FROM (OLD.ended_at,OLD.end_reason) THEN
    RAISE EXCEPTION 'frozen: an ended signature stays ended with its original reason and time';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION sec.t_connector_signature_terminal() FROM PUBLIC, backbone_app, backbone_operator;
GRANT EXECUTE ON FUNCTION sec.t_connector_signature_terminal() TO backbone_owner;
