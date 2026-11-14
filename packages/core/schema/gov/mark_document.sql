-- Anyone who can see a document marks it as private material; lifting the mark is for its task's
-- people or an owner or admin. Marking is not a new version.
CREATE FUNCTION gov.mark_document(p_document uuid, p_sensitive boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  d record;
BEGIN
  IF p_sensitive IS NULL THEN
    RAISE EXCEPTION 'invalid: a mark is set or lifted';
  END IF;
  d := gov._document_audience(p_document, NOT p_sensitive);
  UPDATE app.documents SET sensitive = p_sensitive WHERE workspace_id = sec.current_workspace() AND id = p_document;
  PERFORM gov._append('document.marked', p_document::text, jsonb_build_object('sensitive', p_sensitive));
  RETURN p_sensitive;
END
$$;
