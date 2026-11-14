-- Who may act on a document's marks and words: its task's people, or for a workspace document an
-- owner or admin. A document the person cannot see is not found; a run acts on none.
CREATE FUNCTION gov._document_audience(p_document uuid, p_lifting boolean) RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  me uuid := gov._person('not_by_runs');
  d record;
  t record;
BEGIN
  SELECT * INTO d FROM app.documents x WHERE x.workspace_id = sec.current_workspace() AND x.id = p_document;
  IF NOT FOUND OR (d.task_id IS NOT NULL AND NOT sec.task_visible(d.task_id)) THEN
    RAISE EXCEPTION 'not_found: no such document for this person';
  END IF;
  IF p_lifting THEN
    SELECT * INTO t FROM app.tasks x WHERE x.workspace_id = d.workspace_id AND x.id = d.task_id;
    IF NOT (sec.is_admin(me) OR (d.task_id IS NOT NULL AND (me IN (t.requested_by, t.on_behalf_of)
            OR EXISTS (SELECT FROM app.task_people tp WHERE tp.workspace_id = t.workspace_id AND tp.task_id = t.id AND tp.person_id = me)))) THEN
      RAISE EXCEPTION 'role: a document''s task''s people, or an owner or admin, vouch for it';
    END IF;
  END IF;
  RETURN d;
END
$$;
