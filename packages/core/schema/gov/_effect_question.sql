-- The question an effect's checker reads: what the act is and, for work marked both ways, what it
-- read. The person whose material it is reads which material; anyone else reads its kinds and whose.
CREATE FUNCTION gov._effect_question(p_effect uuid, p_checker uuid DEFAULT NULL) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN e.description = '' THEN e.operation ELSE e.description END || '.'
    || CASE WHEN r.tainted_untrusted AND r.tainted_sensitive THEN
         CASE WHEN p_checker IS NOT NULL AND p_checker = e.on_behalf_of_id
           THEN ' This run read untrusted content from ' || r.untrusted_source || ' and private material from ' || r.sensitive_source || '.'
           ELSE ' This run read untrusted content and private material, which only ' || gov._person_name(e.on_behalf_of_id) || ' may see.'
         END
         || CASE WHEN e.operation = 'workspace.write_document' AND e.route_reason = 'rule_of_two'
              THEN ' Writing it would show that material to people who could not see it.' ELSE '' END
       ELSE '' END
  FROM app.effects e
  LEFT JOIN app.runs r ON r.workspace_id = e.workspace_id AND r.id = e.run_id
  WHERE e.workspace_id = sec.current_workspace() AND e.id = p_effect
$$;
