-- Material closure foundation v1. Canonical versioned source; see its closed manifest.
CREATE CONSTRAINT TRIGGER candidate_input_structure
AFTER INSERT ON app.knowledge_candidates
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION sec.t_candidate_input_structure();
ALTER TABLE app.knowledge_candidates ENABLE ALWAYS TRIGGER candidate_input_structure;
