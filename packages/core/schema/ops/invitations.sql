-- Invitations to a workspace, by the hash of their one-time token.
CREATE TABLE ops.invitations (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  workspace_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
  invited_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_by text,
  accepted_at timestamptz
);
GRANT SELECT, UPDATE ON ops.invitations TO backbone_gov;
