-- Register a piece (a module or a surface) from its manifest (schemas/backbone.module.schema.json):
-- its id, version, content digest and declared capabilities. Only a person who owns or administers
-- the workspace registers one, never a run, an agent or the system principal, so a piece cannot
-- register itself. The digest is a sha256, never a git reference. Registering the same content
-- again returns its standing registration; a new version or digest is a new registration, which
-- widens nothing already bound to an earlier one.
CREATE FUNCTION gov.register_piece(p_manifest jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  ws uuid := sec.current_workspace();
  me uuid := sec.current_principal();
  caps jsonb := p_manifest -> 'capabilities';
  classes smallint[];
  existing uuid;
  new_id uuid := gen_random_uuid();
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no_identity: the session acts as nobody';
  END IF;
  IF sec.names_run() THEN
    RAISE EXCEPTION 'not_by_runs: a piece never registers itself; the person or an admin does';
  END IF;
  IF sec.principal_kind(me) IS DISTINCT FROM 'person' OR NOT sec.is_admin(me) THEN
    RAISE EXCEPTION 'role: only the workspace''s owner or an admin registers a piece';
  END IF;
  IF jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' OR p_manifest -> 'manifest' IS DISTINCT FROM '1'::jsonb
     OR jsonb_typeof(p_manifest -> 'id') IS DISTINCT FROM 'string' OR jsonb_typeof(p_manifest -> 'version') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_manifest -> 'kind') IS DISTINCT FROM 'string' OR jsonb_typeof(caps) IS DISTINCT FROM 'object'
     OR jsonb_typeof(caps -> 'planes') IS DISTINCT FROM 'array' OR jsonb_typeof(caps -> 'operations') IS DISTINCT FROM 'array'
     OR jsonb_typeof(caps -> 'effectClasses') IS DISTINCT FROM 'array' OR jsonb_typeof(caps -> 'network') IS DISTINCT FROM 'array'
     OR EXISTS (SELECT FROM jsonb_array_elements(caps -> 'operations') o WHERE jsonb_typeof(o) <> 'string')
     OR EXISTS (SELECT FROM jsonb_array_elements(caps -> 'effectClasses') c WHERE jsonb_typeof(c) <> 'number') THEN
    RAISE EXCEPTION 'invalid: a piece is registered from its whole manifest';
  END IF;
  IF p_manifest ->> 'kind' NOT IN ('module', 'surface') THEN
    RAISE EXCEPTION 'invalid: only modules and surfaces are registered; the core and the platform are the installation';
  END IF;
  IF coalesce(p_manifest ->> 'digest', '') !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid: a piece''s digest is the sha256 of its content, never a git reference';
  END IF;
  SELECT array_agg(c::smallint) INTO classes FROM jsonb_array_elements_text(caps -> 'effectClasses') c;
  SELECT id INTO existing FROM app.pieces x
  WHERE x.workspace_id = ws AND x.piece = p_manifest ->> 'id' AND x.digest = p_manifest ->> 'digest' AND x.unregistered_at IS NULL;
  IF FOUND THEN
    RETURN existing;
  END IF;
  INSERT INTO app.pieces (workspace_id, id, piece, kind, version, digest, planes, operations, effect_classes, effect_ceiling,
                          network, secrets, manifest, registered_by)
  VALUES (ws, new_id, p_manifest ->> 'id', p_manifest ->> 'kind', p_manifest ->> 'version', p_manifest ->> 'digest',
          caps -> 'planes', caps -> 'operations', coalesce(classes, '{}'), 0, caps -> 'network', caps ->> 'secrets', p_manifest, me);
  PERFORM gov._append('piece.registered', new_id::text, jsonb_build_object(
    'piece', p_manifest ->> 'id', 'version', p_manifest ->> 'version', 'digest', p_manifest ->> 'digest'));
  RETURN new_id;
END
$$;
