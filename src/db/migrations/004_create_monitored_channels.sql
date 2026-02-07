-- Table to store monitored channels (configured via slash commands)
CREATE TABLE IF NOT EXISTS monitored_channels (
  id SERIAL PRIMARY KEY,
  channel_id VARCHAR(20) UNIQUE NOT NULL,
  channel_name VARCHAR(100),
  added_by VARCHAR(20) NOT NULL,
  added_at TIMESTAMP DEFAULT NOW(),
  enabled BOOLEAN DEFAULT TRUE
);

-- Index for finding enabled channels
CREATE INDEX IF NOT EXISTS idx_monitored_channels_enabled ON monitored_channels (enabled);
