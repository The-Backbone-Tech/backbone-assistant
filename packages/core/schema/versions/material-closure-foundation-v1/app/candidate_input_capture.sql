-- Material closure foundation v1. Canonical versioned source; see its closed manifest.
CREATE TRIGGER candidate_input_capture BEFORE INSERT ON app.knowledge_candidates
FOR EACH ROW EXECUTE FUNCTION sec.t_candidate_input_capture_v1();
ALTER TABLE app.knowledge_candidates ENABLE ALWAYS TRIGGER candidate_input_capture;
