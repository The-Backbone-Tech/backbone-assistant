-- A person who vouches for a document's words lifts what they carried (untrusted, private, imported):
-- its task's people, or for a workspace document an owner or admin. Never a run.
CREATE FUNCTION gov.review_document(p_document uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  d record;
BEGIN
  d := gov._document_audience(p_document, true);
  UPDATE app.documents SET words_untrusted = false, words_sensitive = false, imported = false
  WHERE workspace_id = sec.current_workspace() AND id = p_document;
  PERFORM gov._append('document.reviewed', p_document::text, jsonb_build_object(
    'version', d.version, 'untrusted', d.words_untrusted, 'sensitive', d.words_sensitive, 'imported', d.imported));
  RETURN d.version;
END
$$;
