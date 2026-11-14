-- Built-in operations: their class and reach are fixed, whatever the catalogue says, and a hint
-- may only raise them. `undo` names the operation that reverses one.
CREATE FUNCTION gov._builtin(p_operation text) RETURNS TABLE (effect_class smallint, external boolean, undo text)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $$
  SELECT c::smallint, x, u FROM (VALUES
    ('payment.send', 5, true, NULL),
    ('access.grant', 6, true, NULL),
    ('email.send', 4, true, NULL),
    ('workspace.post_message', 2, false, NULL),
    ('workspace.update_task', 2, false, NULL),
    ('workspace.write_document', 2, false, 'workspace.restore_document'),
    ('workspace.restore_document', 2, false, NULL)
  ) AS b (op, c, x, u) WHERE op = p_operation
$$;
