-- How an account signs in: a passkey, or an identity provider's subject (SSO).
CREATE TABLE auth.identities (
  user_id text NOT NULL REFERENCES auth.users (id),
  provider text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider, subject)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.identities TO backbone_app;
