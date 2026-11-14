-- The principal acting now proposes a statement for accepted knowledge, with verbatim evidence from
-- recorded sources. It names no terms of its own: those are set when promotion is requested. What
-- the proposing run had read, and what its evidence is, come with the candidate.
CREATE OR REPLACE FUNCTION gov.propose_candidate(p_statement text, p_evidence jsonb, p_proposed_by uuid, p_topic text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  old_person text:=coalesce(current_setting('backbone.principal',true),''); old_run text:=coalesce(current_setting('backbone.run',true),''); old_secret text:=coalesce(current_setting('backbone.secret',true),'');
  ws uuid := sec.current_workspace();
  me uuid := sec.current_principal();
  run uuid := sec.current_run();
  run_untrusted boolean := false;
  run_sensitive boolean := false;
  new_id uuid := gen_random_uuid();
  untrusted boolean;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no_identity: the session acts as nobody';
  END IF;
  IF p_proposed_by IS DISTINCT FROM me THEN
    RAISE EXCEPTION 'denied: a candidate is proposed by the principal acting now';
  END IF;
  IF p_statement IS NULL OR length(p_statement) NOT BETWEEN 1 AND 4000 OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_evidence) = 0 THEN
    RAISE EXCEPTION 'invalid: a candidate states something and cites its evidence';
  END IF;
  -- Resolve presence under the original audience before any privileged metadata read.
  IF EXISTS (SELECT FROM jsonb_array_elements(p_evidence) x
             WHERE NOT EXISTS (SELECT FROM app.episodes e WHERE e.workspace_id=ws AND e.id::text=x->>'episode')) THEN
    RAISE EXCEPTION 'denied: candidate citation is outside its receiving audience';
  END IF;
  PERFORM set_config('backbone.run','',true); PERFORM set_config('backbone.secret','',true); PERFORM set_config('backbone.principal',sec.system_principal()::text,true);
  IF EXISTS (SELECT FROM jsonb_array_elements(p_evidence) x
             WHERE NOT EXISTS (SELECT FROM app.episodes e WHERE e.workspace_id = ws AND e.id::text = x ->> 'episode')) THEN
    RAISE EXCEPTION 'denied: candidate citation is outside its receiving audience';
  END IF;
  SELECT bool_or(e.trust = 'untrusted') INTO untrusted FROM jsonb_array_elements(p_evidence) x
  JOIN app.episodes e ON e.workspace_id = ws AND e.id::text = x ->> 'episode';
  PERFORM set_config('backbone.principal',old_person,true); PERFORM set_config('backbone.run',old_run,true); PERFORM set_config('backbone.secret',old_secret,true);
  IF run IS NOT NULL THEN
    SELECT x.tainted_untrusted, x.tainted_sensitive INTO run_untrusted, run_sensitive FROM app.runs x WHERE x.workspace_id = ws AND x.id = run;
  END IF;
  INSERT INTO app.knowledge_candidates (workspace_id, id, statement, topic, evidence, proposed_by, run_id, on_behalf_of,
                                        words_untrusted, kept)
  VALUES (ws, new_id, p_statement, coalesce(p_topic, 'general'), p_evidence, me, run, sec.acting_for(),
          coalesce(untrusted, false) OR run_untrusted,
          run_untrusted AND run_sensitive);
  PERFORM gov._append('knowledge.proposed', new_id::text, jsonb_build_object('run', run, 'topic', sec.digest(p_topic)));
  RETURN new_id;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('backbone.principal',old_person,true); PERFORM set_config('backbone.run',old_run,true); PERFORM set_config('backbone.secret',old_secret,true);
  RAISE;
END
$$;
