-- Store last poll timestamp per channel
CREATE TABLE IF NOT EXISTS channel_poll_state (
  channel_id TEXT PRIMARY KEY,
  last_poll_ts TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);
