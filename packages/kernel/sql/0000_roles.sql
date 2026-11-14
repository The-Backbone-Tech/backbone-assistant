-- Installer-only roles: owner owns tables; gov owns definers; app logs in; observer is the door, which acts for
-- runs with nobody present; identity alone makes a person's authority. No login may hold both of the last two.
-- Every role lacks superuser, RLS bypass and role/database creation; passwords are installed separately.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['backbone_owner','backbone_gov','backbone_app','planes_observer','planes_identity'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I',r); END IF;
    EXECUTE format('ALTER ROLE %I NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION %s',r,
      CASE WHEN r='backbone_app' THEN 'LOGIN' ELSE 'NOLOGIN' END);
  END LOOP;
END $$;
