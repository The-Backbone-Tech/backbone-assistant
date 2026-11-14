-- A blocked copy names its original, which is an earlier root of the same exact change in the same
-- workspace, and the copy itself is a denied receipt. Checked when the transaction commits, so a
-- forged cycle or a mismatched copy is refused however it is written.
CREATE FUNCTION sec.t_effect_lineage() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  o record;
BEGIN
  IF NEW.repeat_of IS NULL THEN
    RETURN NULL;
  END IF;
  IF NEW.repeat_of = NEW.id THEN
    RAISE EXCEPTION 'invalid: an effect is never a copy of itself';
  END IF;
  IF NEW.status <> 'denied' OR NEW.route IS DISTINCT FROM 'denied'
     OR NEW.route_reason NOT IN ('repeat_pending', 'repeat_unknown_blocked') THEN
    RAISE EXCEPTION 'invalid: a copy of an unresolved change is a denied receipt';
  END IF;
  SELECT * INTO o FROM app.effects WHERE workspace_id = NEW.workspace_id AND id = NEW.repeat_of;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid: a copy names an original that does not exist in its workspace';
  END IF;
  IF o.repeat_of IS NOT NULL THEN
    RAISE EXCEPTION 'invalid: a copy''s original is never itself a copy';
  END IF;
  -- A document write that only adds the task its new document goes into is the same change (gov.propose_effect).
  IF (o.task_id, o.on_behalf_of_id, o.operation, o.connection, o.expected_version)
     IS DISTINCT FROM (NEW.task_id, NEW.on_behalf_of_id, NEW.operation, NEW.connection, NEW.expected_version)
     OR (o.args_hash IS DISTINCT FROM NEW.args_hash AND NOT (NEW.operation = 'workspace.write_document'
         AND sec.args_hash(o.args - 'task_id') = sec.args_hash(NEW.args - 'task_id'))) THEN
    RAISE EXCEPTION 'invalid: a copy is the exact change of its original';
  END IF;
  RETURN NULL;
END
$$;
