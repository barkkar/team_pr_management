ALTER TABLE monitored_channels
  ADD COLUMN IF NOT EXISTS reminder_interval_hours INT NOT NULL DEFAULT 2
    CHECK (reminder_interval_hours BETWEEN 1 AND 24),
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles';
