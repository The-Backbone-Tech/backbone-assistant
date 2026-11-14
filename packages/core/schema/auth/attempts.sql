-- Sign-in attempts, per account and per address: the throttle lives in the database.
CREATE TABLE auth.attempts (
  key text NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  succeeded boolean NOT NULL
);
CREATE INDEX attempts_key ON auth.attempts (key, at);
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.attempts TO backbone_app;
