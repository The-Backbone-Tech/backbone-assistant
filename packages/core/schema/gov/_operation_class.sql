-- An operation's class and reach as the gateway decides them: fixed for a built-in, the
-- catalogue's otherwise, and a reversible external change (class 3) for an operation nobody
-- classified, except a first-party profile's own reads (class 1). The tool's own hints may raise the class and make it external, never the reverse.
CREATE FUNCTION gov._operation_class(p_operation text, p_class_hint smallint, p_external_hint boolean, p_connection uuid,
                                     OUT effect_class smallint, OUT external boolean, OUT undo text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  b record;
  o record;
BEGIN
  SELECT * INTO b FROM gov._builtin(p_operation);
  IF FOUND THEN
    effect_class := b.effect_class;
    external := b.external;
    undo := b.undo;
  ELSE
    SELECT * INTO o FROM app.operations x WHERE x.workspace_id = sec.current_workspace() AND x.operation = p_operation;
    IF FOUND THEN
      effect_class := o.effect_class;
      external := o.external;
      undo := o.undo_operation;
    ELSIF EXISTS (SELECT FROM app.connections c JOIN gov._profile_reads() pr ON pr.profile = c.profile
                  WHERE c.workspace_id = sec.current_workspace() AND c.id = p_connection AND pr.tool = split_part(p_operation, '.', 3)) THEN
      effect_class := 1;
      external := true;
      undo := NULL;
    ELSE
      effect_class := 3;
      external := true;
      undo := NULL;
    END IF;
  END IF;
  IF p_class_hint IS NOT NULL AND p_class_hint > effect_class THEN
    effect_class := least(p_class_hint, 6);
  END IF;
  external := external OR coalesce(p_external_hint, false);
END
$$;
