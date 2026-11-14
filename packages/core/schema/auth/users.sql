-- Accounts that sign in. The service's own: no crossing reaches them.
CREATE TABLE auth.users (
  id text PRIMARY KEY,
  email text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.users TO backbone_app;
