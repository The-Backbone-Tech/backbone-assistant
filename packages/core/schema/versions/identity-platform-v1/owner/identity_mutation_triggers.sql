CREATE TRIGGER identity_mutation_context BEFORE UPDATE OR DELETE ON app.episodes
FOR EACH STATEMENT EXECUTE FUNCTION sec.t_identity_mutation_context();
CREATE TRIGGER identity_mutation_context BEFORE UPDATE OR DELETE ON app.knowledge_candidates
FOR EACH STATEMENT EXECUTE FUNCTION sec.t_identity_mutation_context();
CREATE TRIGGER identity_mutation_context BEFORE UPDATE OR DELETE ON app.ledger
FOR EACH STATEMENT EXECUTE FUNCTION sec.t_identity_mutation_context();
