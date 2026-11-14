-- Raise a run's marks from what it read: untrusted content, private material, and private material
-- from beyond its own conversation. Marks only rise, and the first reason given for each stays.
CREATE FUNCTION gov._mark(p_run uuid, p_untrusted text, p_sensitive text, p_elsewhere text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  UPDATE app.runs SET
    tainted_untrusted = tainted_untrusted OR p_untrusted IS NOT NULL,
    untrusted_source = coalesce(untrusted_source, p_untrusted),
    tainted_sensitive = tainted_sensitive OR p_sensitive IS NOT NULL,
    sensitive_source = coalesce(sensitive_source, p_sensitive),
    elsewhere_source = coalesce(elsewhere_source, p_elsewhere)
  WHERE workspace_id = sec.current_workspace() AND id = p_run
    AND ((p_untrusted IS NOT NULL AND NOT tainted_untrusted) OR (p_sensitive IS NOT NULL AND NOT tainted_sensitive)
         OR (p_elsewhere IS NOT NULL AND elsewhere_source IS NULL));
END
$$;
