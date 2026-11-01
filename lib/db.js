// SQLite database (Node.js built-in). Shared by the web server and the background worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'media'), { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'app.db'));
// Wait (instead of failing) if the web app and the worker touch the database at the same moment.
db.exec('PRAGMA busy_timeout = 15000;');
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,              -- google | microsoft | whatsapp
  label TEXT NOT NULL,
  identifier TEXT,                     -- email address or phone number id
  secret TEXT,                         -- encrypted credentials (AES-256-GCM)
  info TEXT DEFAULT '{}',              -- non-secret details (display number, waba id...)
  status TEXT NOT NULL DEFAULT 'connected',  -- connected | needs_attention | disconnected
  last_error TEXT,
  tested_at TEXT,
  checked_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sheet_provider TEXT,                 -- google | microsoft | demo
  sheet_account_id INTEGER,
  sheet_ref TEXT DEFAULT '{}',
  sheet_tab TEXT,
  header_row INTEGER NOT NULL DEFAULT 1,
  column_map TEXT DEFAULT '{}',
  gmail_account_id INTEGER,
  whatsapp_account_id INTEGER,
  status TEXT NOT NULL DEFAULT 'paused',   -- active | paused
  mode TEXT NOT NULL DEFAULT 'test',       -- test | live
  settings TEXT DEFAULT '{}',
  sheet_status TEXT DEFAULT 'not_connected', -- not_connected | ok | error
  sheet_error TEXT,
  last_polled_at TEXT,
  baseline_test_done INTEGER DEFAULT 0,
  baseline_live_done INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS templates (
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (shop_id, channel)
);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                  -- file | link
  title TEXT,
  filename TEXT,
  mime TEXT,
  size INTEGER,
  storage_name TEXT,
  url TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media_selection (
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, channel, media_id)
);

CREATE TABLE IF NOT EXISTS wa_media_cache (
  media_id INTEGER NOT NULL, account_id INTEGER NOT NULL,
  wa_media_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY (media_id, account_id)
);

CREATE TABLE IF NOT EXISTS contacts_seen (
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  identity TEXT NOT NULL,
  content_hash TEXT,
  row_number INTEGER,
  baseline INTEGER DEFAULT 0,
  first_seen_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (shop_id, mode, identity)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,               -- email | whatsapp
  mode TEXT NOT NULL,                  -- test | live
  campaign TEXT NOT NULL,
  recipient TEXT,
  idem_key TEXT NOT NULL UNIQUE,       -- shop|mode|campaign|channel|recipient|revision
  row_identity TEXT NOT NULL,
  row_number INTEGER,
  payload TEXT NOT NULL DEFAULT '{}',  -- snapshot of the row values used for this message
  status TEXT NOT NULL DEFAULT 'pending',
  error_kind TEXT,
  last_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  simulated INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  delivered_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS jobs_row ON jobs(shop_id, mode, row_identity);
CREATE INDEX IF NOT EXISTS jobs_provider ON jobs(provider_message_id);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  shop_id INTEGER,
  job_id INTEGER,
  channel TEXT,
  contact_ref TEXT,
  event TEXT,
  result TEXT,
  detail TEXT,
  simulated INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS activity_shop ON activity(shop_id, id);

CREATE TABLE IF NOT EXISTS suppression (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,                 -- 'global' or the shop id
  channel TEXT NOT NULL DEFAULT 'all', -- all | email | whatsapp
  value TEXT NOT NULL,                 -- normalized email or +phone
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (scope, channel, value)
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  shop_id INTEGER,
  account_id INTEGER,
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  notified_at TEXT
);

CREATE TABLE IF NOT EXISTS sheet_dirty (
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  row_identity TEXT NOT NULL,
  PRIMARY KEY (shop_id, mode, row_identity)
);

CREATE TABLE IF NOT EXISTS wa_inbound (phone TEXT PRIMARY KEY, last_inbound_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS demo_sheets (shop_id INTEGER PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE, rows TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, provider TEXT, data TEXT, created_at INTEGER);
`);

// ---------- small helpers ----------
export const now = () => Date.now();
export const iso = (ms = Date.now()) => new Date(ms).toISOString();

export function one(sql, ...params) { return db.prepare(sql).get(...params) || null; }
export function all(sql, ...params) { return db.prepare(sql).all(...params); }
export function run(sql, ...params) { return db.prepare(sql).run(...params); }

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function getSetting(key, def = null) {
  const r = one('SELECT value FROM settings WHERE key = ?', key);
  return r ? JSON.parse(r.value) : def;
}
export function setSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

export const DEFAULT_SHOP_SETTINGS = {
  channels: 'both',                 // email | whatsapp | both
  delay_minutes: 0,
  schedule: { enabled: false, tz: 'Asia/Dubai', days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '21:00' },
  conditions: [],                   // [{ column, op, value }]
  consent: { required: true, accepted: 'yes, y, true, 1, agreed, accepted, نعم' },
  resend_on_edit: false,
  campaign: 'welcome',
  default_country_code: '971',
};

export function parseShop(row) {
  if (!row) return null;
  const s = { ...row };
  s.sheet_ref = JSON.parse(row.sheet_ref || '{}');
  s.column_map = JSON.parse(row.column_map || '{}');
  const st = JSON.parse(row.settings || '{}');
  s.settings = { ...DEFAULT_SHOP_SETTINGS, ...st, schedule: { ...DEFAULT_SHOP_SETTINGS.schedule, ...(st.schedule || {}) }, consent: { ...DEFAULT_SHOP_SETTINGS.consent, ...(st.consent || {}) } };
  return s;
}
export const getShop = (id) => parseShop(one('SELECT * FROM shops WHERE id = ?', id));
export const allShops = () => all('SELECT * FROM shops ORDER BY name COLLATE NOCASE').map(parseShop);

export function getTemplate(shopId, channel) {
  const r = one('SELECT data FROM templates WHERE shop_id = ? AND channel = ?', shopId, channel);
  return r ? JSON.parse(r.data) : null;
}

export function logActivity({ shop_id = null, job_id = null, channel = null, contact_ref = null, event, result = null, detail = null, simulated = 0 }) {
  run('INSERT INTO activity (shop_id, job_id, channel, contact_ref, event, result, detail, simulated) VALUES (?,?,?,?,?,?,?,?)',
    shop_id, job_id, channel, contact_ref, event, result, detail ? String(detail).slice(0, 1000) : null, simulated ? 1 : 0);
}

export function raiseAlert(key, message, { shop_id = null, account_id = null } = {}) {
  const ex = one('SELECT * FROM alerts WHERE key = ?', key);
  if (ex && !ex.resolved_at) { if (ex.message !== message) run('UPDATE alerts SET message = ? WHERE id = ?', message, ex.id); return; }
  if (ex) run("UPDATE alerts SET message = ?, created_at = datetime('now'), resolved_at = NULL, notified_at = NULL WHERE id = ?", message, ex.id);
  else run('INSERT INTO alerts (key, shop_id, account_id, message) VALUES (?,?,?,?)', key, shop_id, account_id, message);
}
export function resolveAlert(key) { run("UPDATE alerts SET resolved_at = datetime('now') WHERE key = ? AND resolved_at IS NULL", key); }
