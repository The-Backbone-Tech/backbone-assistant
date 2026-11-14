-- A run's marks only rise, and why a mark was set never changes once set. Its identity and
-- mandate never change either.
CREATE FUNCTION sec.t_run_marks() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'frozen: runs are never deleted';
  END IF;
  IF (OLD.tainted_untrusted AND NOT NEW.tainted_untrusted) OR (OLD.tainted_sensitive AND NOT NEW.tainted_sensitive)
     OR (OLD.untrusted_source IS NOT NULL AND NEW.untrusted_source IS DISTINCT FROM OLD.untrusted_source)
     OR (OLD.sensitive_source IS NOT NULL AND NEW.sensitive_source IS DISTINCT FROM OLD.sensitive_source)
     OR (OLD.elsewhere_source IS NOT NULL AND NEW.elsewhere_source IS DISTINCT FROM OLD.elsewhere_source) THEN
    RAISE EXCEPTION 'frozen: marks only rise, and why they were set never changes';
  END IF;
  IF NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.mandate_id IS DISTINCT FROM OLD.mandate_id OR NEW.fence < OLD.fence THEN
    RAISE EXCEPTION 'frozen: a run keeps its task, agent and mandate, and its fence only rises';
  END IF;
  RETURN NEW;
END
$$;
