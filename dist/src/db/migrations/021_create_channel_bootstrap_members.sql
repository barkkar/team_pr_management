CREATE TABLE IF NOT EXISTS channel_bootstrap_members (
  id            SERIAL PRIMARY KEY,
  channel_id    TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  email         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  claimed_at    TIMESTAMP,
  enqueued_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMP,
  UNIQUE (channel_id, slack_user_id)
);

CREATE INDEX IF NOT EXISTS idx_cbm_status_enqueued
  ON channel_bootstrap_members (status, enqueued_at);
