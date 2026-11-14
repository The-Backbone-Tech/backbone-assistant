-- The gateway's routing table, the kernel's route() in SQL: 'free', 'allowed', 'allowed_after_window',
-- 'needs_checker:<reason>' or 'denied:<reason>'. A caller that does not state who fixed a read's
-- outbound arguments gets the closed answer (not fixed).
CREATE FUNCTION sec.route_effect(
  p_class smallint, p_standing text, p_ceiling smallint, p_untrusted boolean, p_sensitive boolean,
  p_external boolean, p_outbound_fixed boolean DEFAULT false
) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_standing <> 'ok' THEN 'denied:' || p_standing
    WHEN p_class = 6 THEN 'needs_checker:elevation'
    WHEN p_class = 5 THEN 'needs_checker:final'
    WHEN p_class = 1 THEN CASE WHEN p_untrusted AND p_sensitive AND p_external AND NOT p_outbound_fixed
                               THEN 'needs_checker:rule_of_two' ELSE 'free' END
    WHEN p_class >= 3 AND p_untrusted AND p_sensitive AND p_external THEN 'needs_checker:rule_of_two'
    WHEN p_class > p_ceiling THEN 'needs_checker:above_ceiling'
    WHEN p_class = 4 THEN 'allowed_after_window'
    ELSE 'allowed'
  END
$$;
