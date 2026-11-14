-- The cross-workspace verification queue: questions a verifier answers, taken under a short lease.
-- An escalated or answered question leaves it.
CREATE TABLE ops.verification_queue (
  decision_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  verifier_id uuid NOT NULL,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  worker text,
  enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.verification_queue TO backbone_gov;
