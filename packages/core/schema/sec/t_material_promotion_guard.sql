-- Also catches an old approving function already in flight when the unified upgrade commits.
CREATE FUNCTION sec.t_material_promotion_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM sec.current_workspace()
     OR NOT gov._promotion_sources_allowed(NEW.candidate_id) THEN
    RAISE EXCEPTION 'paused: promotion awaits source withdrawal verification';
  END IF;
  RETURN NEW;
END
$$;
