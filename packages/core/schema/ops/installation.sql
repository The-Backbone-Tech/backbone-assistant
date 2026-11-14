-- The installation itself: whether its first workspace was created by the service.
CREATE TABLE ops.installation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  first_workspace uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO ops.installation DEFAULT VALUES;
GRANT SELECT, UPDATE ON ops.installation TO backbone_gov;
