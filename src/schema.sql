-- SheetSender database schema. Safe to run on every start (only creates what is missing).
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Dubai',
  default_country TEXT NOT NULL DEFAULT 'AE',
  send_start SMALLINT NOT NULL DEFAULT 9,
  send_end SMALLINT NOT NULL DEFAULT 18,
  webhook_key TEXT NOT NULL,
  failed_logins INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_webhook_key_uq ON users (webhook_key);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS shops (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  current_upload_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS shops_name_uq ON shops (user_id, lower(name));

CREATE TABLE IF NOT EXISTS uploads (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  headers JSONB NOT NULL,
  rows JSONB,
  row_count INT NOT NULL DEFAULT 0,
  mapping JSONB,
  status TEXT NOT NULL DEFAULT 'needs_mapping',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS uploads_shop_idx ON uploads (shop_id);

CREATE TABLE IF NOT EXISTS contacts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  upload_id BIGINT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  row_number INT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  email TEXT,
  email_raw TEXT NOT NULL DEFAULT '',
  phone TEXT,
  phone_raw TEXT NOT NULL DEFAULT '',
  consent_email BOOLEAN NOT NULL DEFAULT false,
  consent_whatsapp BOOLEAN NOT NULL DEFAULT false,
  consent_raw TEXT NOT NULL DEFAULT '',
  extra JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS contacts_upload_idx ON contacts (upload_id, row_number);
CREATE INDEX IF NOT EXISTS contacts_user_idx ON contacts (user_id);

CREATE TABLE IF NOT EXISTS senders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unverified',
  secrets TEXT NOT NULL,
  info JSONB NOT NULL DEFAULT '{}',
  daily_limit INT NOT NULL DEFAULT 0,
  hold_until TIMESTAMPTZ,
  hold_reason TEXT,
  hold_level INT NOT NULL DEFAULT 0,
  verify_code_hash TEXT,
  verify_expires TIMESTAMPTZ,
  verify_attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS senders_user_idx ON senders (user_id);

CREATE TABLE IF NOT EXISTS suppressions (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  address TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel, address)
);

CREATE TABLE IF NOT EXISTS media (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaigns (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  sender_id BIGINT REFERENCES senders(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  mode TEXT NOT NULL DEFAULT 'auto',
  audience TEXT NOT NULL DEFAULT 'all',
  selected_ids JSONB NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  template JSONB,
  media_ids JSONB NOT NULL DEFAULT '[]',
  wa_media JSONB,
  skip_already_received BOOLEAN NOT NULL DEFAULT true,
  content_hash TEXT,
  activation_key TEXT NOT NULL,
  paused_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS campaigns_activation_uq ON campaigns (activation_key);
CREATE INDEX IF NOT EXISTS campaigns_user_idx ON campaigns (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS campaigns_status_idx ON campaigns (status);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id BIGINT,
  channel TEXT NOT NULL,
  contact_id BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
  row_number INT,
  recipient_name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  vars JSONB NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL,
  skip_reason TEXT,
  error TEXT,
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  provider_id TEXT,
  content_hash TEXT,
  sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_dedupe_uq ON messages (campaign_id, dedupe_key);
CREATE INDEX IF NOT EXISTS messages_campaign_status_idx ON messages (campaign_id, status, id);
CREATE INDEX IF NOT EXISTS messages_provider_idx ON messages (provider_id);
CREATE INDEX IF NOT EXISTS messages_sent_idx ON messages (user_id, channel, sent_at);
CREATE INDEX IF NOT EXISTS messages_sender_sent_idx ON messages (sender_id, sent_at);
