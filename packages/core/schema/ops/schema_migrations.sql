-- What was applied to this database: the baseline, by checksum, then each later migration.
CREATE TABLE ops.schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
