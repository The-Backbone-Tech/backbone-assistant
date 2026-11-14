-- Signed-in sessions, by the hash of their token.
CREATE TABLE auth.sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth.users (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.sessions TO backbone_app;
