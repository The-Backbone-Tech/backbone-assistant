-- The installation's roles and schemas (identity-tenancy contract).
--
--   backbone_owner     owns every store and schema; never logs in. Owning a store gives it no way
--                      round the storage rules: row-level security is forced and triggers refuse.
--   backbone_gov       owns the crossings (SECURITY DEFINER, pinned search_path). It reaches the
--                      tenant stores under the same walls as the session, and never the accounts.
--   backbone_app       the service. It reads the tenant stores it is granted, writes nothing
--                      directly, executes the published crossings and reaches the accounts.
--   backbone_operator  the installation's operator: creates workspaces through operator.* only.
--
-- None of them is a superuser or may bypass row-level security. Passwords are set by whoever
-- installs, never here.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'backbone_owner') THEN
    CREATE ROLE backbone_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'backbone_gov') THEN
    CREATE ROLE backbone_gov NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'backbone_app') THEN
    CREATE ROLE backbone_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'backbone_operator') THEN
    CREATE ROLE backbone_operator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Credentials are sent as bind parameters; do not put bind values in PostgreSQL logs.
ALTER ROLE backbone_app SET log_parameter_max_length = 0;
ALTER ROLE backbone_app SET log_parameter_max_length_on_error = 0;
ALTER ROLE backbone_operator SET log_parameter_max_length = 0;
ALTER ROLE backbone_operator SET log_parameter_max_length_on_error = 0;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA app AUTHORIZATION backbone_owner;      -- tenant stores, every one walled
CREATE SCHEMA auth AUTHORIZATION backbone_owner;     -- accounts: the service's alone
CREATE SCHEMA ops AUTHORIZATION backbone_owner;      -- queues, keys, migrations: crossings only
CREATE SCHEMA sec AUTHORIZATION backbone_owner;      -- session identity and the policy helpers
CREATE SCHEMA gov AUTHORIZATION backbone_gov;        -- the published crossings (internal ones start with _)
CREATE SCHEMA operator AUTHORIZATION backbone_gov;   -- the operator's crossings
CREATE SCHEMA crypto AUTHORIZATION backbone_owner;   -- pgcrypto, for keyed digests

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA crypto;

GRANT USAGE ON SCHEMA sec TO backbone_gov;
GRANT CREATE ON SCHEMA sec TO backbone_gov;
GRANT USAGE ON SCHEMA app, ops, crypto TO backbone_gov;
GRANT USAGE ON SCHEMA app, sec, gov, auth TO backbone_app;
GRANT USAGE ON SCHEMA operator TO backbone_operator;

-- No function in a product schema is executable by PUBLIC, including functions created later by
-- the roles that own those schemas.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA crypto FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA crypto TO backbone_gov;
ALTER DEFAULT PRIVILEGES FOR ROLE backbone_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE backbone_gov REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE backbone_owner GRANT EXECUTE ON FUNCTIONS TO backbone_gov;
