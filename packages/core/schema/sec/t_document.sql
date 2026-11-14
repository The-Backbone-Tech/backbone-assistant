-- A document keeps its identity and its task. Every change of its words keeps the previous version
-- and takes the next number, whatever number the writer claims. Marking it sensitive (or not) is not
-- a version and changes nothing else.
CREATE FUNCTION sec.t_document() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'frozen: documents are never deleted';
  END IF;
  IF (NEW.id, NEW.workspace_id, NEW.task_id, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.task_id, OLD.created_at) THEN
    RAISE EXCEPTION 'frozen: a document keeps its identity and its task';
  END IF;
  IF NEW.sensitive IS DISTINCT FROM OLD.sensitive THEN
    IF (NEW.title, NEW.content, NEW.version, NEW.updated_by, NEW.content_author, NEW.via_effect, NEW.words_untrusted,
        NEW.words_sensitive, NEW.imported, NEW.updated_at)
       IS DISTINCT FROM (OLD.title, OLD.content, OLD.version, OLD.updated_by, OLD.content_author, OLD.via_effect,
        OLD.words_untrusted, OLD.words_sensitive, OLD.imported, OLD.updated_at) THEN
      RAISE EXCEPTION 'frozen: marking a document changes nothing else';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.title, NEW.content) IS DISTINCT FROM (OLD.title, OLD.content) THEN
    INSERT INTO app.document_versions (workspace_id, document_id, version, title, content, updated_by, content_author,
                                       via_effect, words_untrusted, words_sensitive, imported, created_at)
    VALUES (OLD.workspace_id, OLD.id, OLD.version, OLD.title, OLD.content, OLD.updated_by, OLD.content_author,
            OLD.via_effect, OLD.words_untrusted, OLD.words_sensitive, OLD.imported, OLD.updated_at);
    NEW.version := OLD.version + 1;
    NEW.updated_at := clock_timestamp();
  ELSIF NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'frozen: a document''s version follows its words';
  END IF;
  RETURN NEW;
END
$$;
