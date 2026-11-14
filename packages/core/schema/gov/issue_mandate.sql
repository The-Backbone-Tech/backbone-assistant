-- Issue a mandate. A root mandate is a person's grant to one of their own workers, bounded by the
-- person's role (a member delegates at most class 3), with a stated ceiling and expiry. A delegated
-- one is the request intersected with its parent (I-3), issued by the parent's holder or
-- its person, to one of that person's workers; a ceiling or expiry left out is the parent's.
-- A root mandate states what carries its work (p_carrier): a registered piece ('piece' with
-- p_piece), whose declaration then bounds that work too, or 'direct' (the person's own direct work,
-- or code the installation trusts as itself). A delegated one stays with its parent's carrier.
CREATE FUNCTION gov.issue_mandate(
  p_subject uuid, p_parent uuid, p_projects jsonb, p_connections jsonb, p_tools jsonb, p_operations jsonb,
  p_ceiling smallint, p_max_tokens bigint, p_max_cost_micros bigint, p_max_duration_ms bigint, p_max_effects bigint,
  p_expires_at timestamptz, p_carrier text, p_intent jsonb DEFAULT '{}', p_piece uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := sec.current_principal();
  subj record;
  p record;
  new_id uuid := gen_random_uuid();
  beneficiary uuid;
  terms jsonb;
  cap smallint;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no_identity: the session acts as nobody';
  END IF;
  -- Serialize parent observation/insertion with revocation, not merely the final ledger append.
  PERFORM gov._lock_workspace();
  FOREACH terms IN ARRAY ARRAY[p_projects, p_connections, p_tools, p_operations] LOOP
    IF terms IS NULL OR NOT (terms = '"*"' OR (jsonb_typeof(terms) = 'array'
        AND NOT EXISTS (SELECT FROM jsonb_array_elements(terms) e WHERE jsonb_typeof(e) <> 'string'))) THEN
      RAISE EXCEPTION 'invalid: each axis of a mandate is "*" or a list of names';
    END IF;
  END LOOP;
  IF gov._names_own_connection(p_connections) OR gov._names_own_connection(p_tools) OR gov._names_own_connection(p_operations) THEN
    RAISE EXCEPTION 'invalid: a mandate never names a person''s own connection';
  END IF;
  SELECT * INTO subj FROM app.principals WHERE workspace_id = ws AND id = p_subject;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such agent in this workspace';
  END IF;
  IF p_parent IS NULL THEN
    IF sec.names_run() OR sec.principal_kind(me) <> 'person' THEN
      RAISE EXCEPTION 'role: only a person grants a root mandate';
    END IF;
    IF subj.kind <> 'agent' OR subj.agent_role <> 'worker' OR subj.owner_id <> me THEN
      RAISE EXCEPTION 'role: a person grants root mandates only to their own workers';
    END IF;
    IF p_ceiling IS NULL OR p_expires_at IS NULL THEN
      RAISE EXCEPTION 'invalid: a root mandate states its ceiling and its expiry';
    END IF;
    cap := CASE sec.role_of(me) WHEN 'owner' THEN 4 WHEN 'admin' THEN 4 WHEN 'member' THEN 3 END;
    IF cap IS NULL THEN
      RAISE EXCEPTION 'role: a guest grants no mandates';
    END IF;
    IF p_ceiling NOT BETWEEN 1 AND 4 OR p_expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'invalid: a ceiling is 1 to 4 and an expiry is in the future';
    END IF;
    IF p_carrier IS NULL OR NOT ((p_carrier = 'piece' AND p_piece IS NOT NULL) OR (p_carrier = 'direct' AND p_piece IS NULL)) THEN
      RAISE EXCEPTION 'invalid: a root mandate states what carries its work: ''piece'' with a registered piece, or ''direct''';
    END IF;
    INSERT INTO app.mandates (workspace_id, id, issuer_id, subject_id, on_behalf_of_id, parent_id, projects, connections,
                              tools, operations, ceiling, max_tokens, max_cost_micros, max_duration_ms, max_effects, expires_at, intent, carrier, piece_id)
    VALUES (ws, new_id, me, p_subject, me, NULL, p_projects, p_connections, p_tools, p_operations, least(p_ceiling, cap),
            p_max_tokens, p_max_cost_micros, p_max_duration_ms, p_max_effects, p_expires_at, coalesce(p_intent, '{}'), p_carrier, p_piece);
    beneficiary := me;
  ELSE
    SELECT * INTO p FROM app.mandates WHERE workspace_id = ws AND id = p_parent;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found: no such parent mandate in this workspace';
    END IF;
    IF p.revoked_at IS NOT NULL OR p.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'revoked: the parent mandate no longer stands';
    END IF;
    IF me NOT IN (p.subject_id, p.on_behalf_of_id) THEN
      RAISE EXCEPTION 'role: only the parent''s holder or its person delegates from it';
    END IF;
    IF subj.kind <> 'agent' OR subj.agent_role <> 'worker' OR subj.owner_id <> p.on_behalf_of_id THEN
      RAISE EXCEPTION 'role: work for a person is delegated only to that person''s workers';
    END IF;
    terms := sec.attenuate(sec.mandate_terms(to_jsonb(p)), jsonb_build_object(
      'projects', p_projects, 'connections', p_connections, 'tools', p_tools, 'operations', p_operations,
      'ceiling', coalesce(p_ceiling, p.ceiling),
      'budget', jsonb_build_object('maxTokens', p_max_tokens, 'maxCostMicros', p_max_cost_micros,
                                   'maxDurationMs', p_max_duration_ms, 'maxEffects', p_max_effects),
      'expiresAt', 0));
    INSERT INTO app.mandates (workspace_id, id, issuer_id, subject_id, on_behalf_of_id, parent_id, projects, connections,
                              tools, operations, ceiling, max_tokens, max_cost_micros, max_duration_ms, max_effects, expires_at, intent, carrier, piece_id)
    VALUES (ws, new_id, me, p_subject, p.on_behalf_of_id, p.id, terms -> 'projects', terms -> 'connections', terms -> 'tools',
            terms -> 'operations', (terms ->> 'ceiling')::smallint, (terms -> 'budget' ->> 'maxTokens')::bigint,
            (terms -> 'budget' ->> 'maxCostMicros')::bigint, (terms -> 'budget' ->> 'maxDurationMs')::bigint,
            (terms -> 'budget' ->> 'maxEffects')::bigint, least(p.expires_at, coalesce(p_expires_at, p.expires_at)),
            coalesce(p_intent, '{}'), coalesce(p_carrier, p.carrier), coalesce(p_piece, p.piece_id));
    beneficiary := p.on_behalf_of_id;
  END IF;
  PERFORM gov._append('mandate.issued', new_id::text, jsonb_build_object(
    'parent', p_parent, 'subject', p_subject, 'on_behalf_of', beneficiary,
    'carrier', (SELECT coalesce(piece_id::text, carrier) FROM app.mandates WHERE workspace_id = ws AND mandates.id = new_id),
    'intent_hash', (SELECT intent_hash FROM app.mandates WHERE workspace_id = ws AND mandates.id = new_id)));
  RETURN new_id;
END
$$;
