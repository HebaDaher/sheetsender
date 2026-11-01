// Web server: dashboard UI, JSON API, OAuth callbacks, WhatsApp webhook, unsubscribe pages, secure file links.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, checkConfig, googleEnabled, microsoftEnabled, ROOT } from './lib/config.js';
import { db, one, all, run, getShop, allShops, getSetting, setSetting, getTemplate, logActivity, resolveAlert, DEFAULT_SHOP_SETTINGS } from './lib/db.js';
import { sign, verify, safeEqual, randomId } from './lib/crypto.js';
import { listAccounts, getAccount, saveAccount, testAccount, googleAuthUrl, googleExchange, microsoftAuthUrl, microsoftExchange } from './lib/accounts.js';
import { providers, setDemoRows, forgetFileCache } from './lib/sheets.js';
import { FIELDS, STATUS_FIELDS, autoMap, CONDITION_OPS, normalizeEmail, normalizePhone, buildVars, renderTemplate } from './lib/contacts.js';
import * as media from './lib/media.js';
import { listTemplates, waProbe, describeTemplate } from './lib/whatsapp.js';
import { encryptJson } from './lib/crypto.js';
import { enabledChannels, liveReadiness, testSend, sampleRecord, composeEmail, composeWhatsApp, handleWebhook, addSuppression, retryJobs, statusText, formatLocal, pollShop } from './lib/engine.js';

const problems = checkConfig();
if (problems.length) { console.error('Configuration problems:\n- ' + problems.join('\n- ') + '\nSee SETUP.md'); process.exit(1); }

const PUBLIC = path.join(ROOT, 'public');
const secureCookie = config.baseUrl.startsWith('https://');

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => { throw new HttpError(400, msg); };

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'content-type': isObj ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function json(req) {
  const b = await readBody(req);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { bad('Invalid JSON'); }
}
function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
const authed = (req) => { const s = verify(cookies(req).ss); return !!(s && s.u === 'admin'); };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const int = (v) => (v === null || v === undefined || v === '' ? null : Number.parseInt(v, 10));
const shopOr404 = (id) => { const s = getShop(int(id)); if (!s) throw new HttpError(404, 'Shop not found'); return s; };

function simplePage(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f6f7f9;color:#1f2328;margin:0;padding:24px 16px}
  .card{max-width:480px;margin:40px auto;background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:28px}h1{font-size:20px;margin:0 0 12px}
  button{font:inherit;padding:10px 16px;border-radius:8px;border:1px solid #0b6e4f;background:#0b6e4f;color:#fff;cursor:pointer;width:100%;margin-top:10px}
  button.secondary{background:#fff;color:#0b6e4f}p{line-height:1.5}</style></head><body><div class="card">${bodyHtml}</div></body></html>`;
}

const loginAttempts = new Map();
function rateLimited(ip) {
  const r = loginAttempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - r.t > 15 * 60000) { r.n = 0; r.t = Date.now(); }
  r.n++; loginAttempts.set(ip, r);
  return r.n > 10;
}

// ---------- shop summary for dashboard cards ----------
function shopCard(s) {
  // Simulated messages are never counted as sent.
  const counts = Object.fromEntries(all(`SELECT status, COUNT(*) n FROM jobs WHERE shop_id=? AND mode=? AND simulated=0 GROUP BY status`, s.id, s.mode).map((r) => [r.status, r.n]));
  const contacts = one('SELECT COUNT(*) n FROM contacts_seen WHERE shop_id=? AND mode=? AND baseline=0', s.id, s.mode).n;
  const acct = (id) => { const a = id ? getAccount(id) : null; return a ? { id: a.id, label: a.label, status: a.status, tested: !!a.tested_at } : null; };
  const last = one(`SELECT ts, event, result, channel, detail FROM activity WHERE shop_id=? AND event IN ('sent','simulated','failed','delivered','read','blocked') ORDER BY id DESC LIMIT 1`, s.id);
  return {
    id: s.id, name: s.name, status: s.status, mode: s.mode, channels: s.settings.channels,
    sheet: { provider: s.sheet_provider, title: s.sheet_ref?.title, tab: s.sheet_tab, status: s.sheet_status, error: s.sheet_error, last_polled_at: s.last_polled_at, file_mode: s.sheet_ref?.mode === 'file' },
    gmail: acct(s.gmail_account_id), whatsapp: acct(s.whatsapp_account_id),
    contacts, counts: { sent: (counts.sent || 0) + (counts.delivered || 0) + (counts.read || 0), pending: (counts.pending || 0) + (counts.processing || 0), failed: (counts.failed || 0) + (counts.blocked || 0), skipped: (counts.skipped || 0) + (counts.invalid || 0) + (counts.opted_out || 0) },
    simulated: one('SELECT COUNT(*) n FROM jobs WHERE shop_id=? AND mode=? AND simulated=1', s.id, s.mode).n,
    last,
  };
}

function shopDetail(s) {
  return { ...shopCard(s), header_row: s.header_row, column_map: s.column_map, settings: s.settings, sheet_ref: s.sheet_ref, sheet_provider: s.sheet_provider, sheet_account_id: s.sheet_account_id, gmail_account_id: s.gmail_account_id, whatsapp_account_id: s.whatsapp_account_id, readiness: liveReadiness(s) };
}

// ---------- API ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, ...opts });

route('POST', '/api/login', async (req, res) => {
  const ip = req.socket.remoteAddress;
  if (rateLimited(ip)) throw new HttpError(429, 'Too many attempts. Wait 15 minutes.');
  const { password } = await json(req);
  if (!password || !safeEqual(password, config.adminPassword)) throw new HttpError(401, 'Wrong password');
  loginAttempts.delete(ip);
  const token = sign({ u: 'admin', exp: Date.now() + 30 * 86400000 });
  send(res, 200, { ok: true }, { 'set-cookie': `ss=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secureCookie ? '; Secure' : ''}` });
}, { public: true });
route('POST', '/api/logout', (req, res) => send(res, 200, { ok: true }, { 'set-cookie': 'ss=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' }));
route('GET', '/api/me', (req, res) => send(res, 200, { authed: authed(req) }), { public: true });

route('GET', '/api/overview', () => {
  const hb = getSetting('worker_heartbeat', 0);
  return {
    global_paused: !!getSetting('global_paused', false),
    worker_online: Date.now() - hb < 60000, worker_last_seen: hb,
    shops: allShops().map(shopCard),
    alerts: all('SELECT id, message, created_at, shop_id FROM alerts WHERE resolved_at IS NULL ORDER BY id DESC LIMIT 20'),
    owner: { email: getSetting('owner_email', ''), phone: getSetting('owner_phone', '') },
  };
});
route('POST', '/api/global-pause', async (req) => {
  const { paused } = await json(req);
  setSetting('global_paused', !!paused);
  logActivity({ event: paused ? 'global_pause' : 'global_resume', result: 'ok' });
  return { ok: true };
});
route('POST', '/api/alerts/:id/dismiss', (req, res, p) => { run("UPDATE alerts SET resolved_at=datetime('now') WHERE id=?", int(p.id)); return { ok: true }; });

// --- settings / test contact ---
route('GET', '/api/settings', () => ({
  owner_email: getSetting('owner_email', ''), owner_phone: getSetting('owner_phone', ''),
  google_enabled: googleEnabled(), microsoft_enabled: microsoftEnabled(), whatsapp_webhook_ready: !!(config.meta.appSecret && config.meta.verifyToken),
  base_url: config.baseUrl, webhook_url: `${config.baseUrl}/webhooks/whatsapp`, poll_seconds: config.pollSeconds,
}));
route('PUT', '/api/settings', async (req) => {
  const b = await json(req);
  if (b.owner_email !== undefined) { if (b.owner_email && !normalizeEmail(b.owner_email)) bad('That email address is not valid'); setSetting('owner_email', normalizeEmail(b.owner_email) || ''); }
  if (b.owner_phone !== undefined) { const p = b.owner_phone ? normalizePhone(b.owner_phone, '971') : ''; if (b.owner_phone && !p) bad('That phone number is not valid. Use international format, e.g. +971501234567'); setSetting('owner_phone', p); }
  return { ok: true, owner_email: getSetting('owner_email', ''), owner_phone: getSetting('owner_phone', '') };
});

// --- accounts ---
route('GET', '/api/accounts', () => listAccounts().map((a) => ({ ...a, used_by: all('SELECT id, name FROM shops WHERE gmail_account_id=? OR whatsapp_account_id=? OR sheet_account_id=?', a.id, a.id, a.id) })));
route('POST', '/api/accounts/whatsapp', async (req) => {
  const b = await json(req);
  const phone_number_id = String(b.phone_number_id || '').trim(), waba_id = String(b.waba_id || '').trim(), access_token = String(b.access_token || '').trim();
  if (!/^\d{6,}$/.test(phone_number_id)) bad('Phone number ID should be a long number (from Meta → WhatsApp → API Setup)');
  if (!/^\d{6,}$/.test(waba_id)) bad('WhatsApp Business Account ID should be a long number');
  if (access_token.length < 20) bad('Paste the permanent System User access token');
  const p = await waProbe({ phone_number_id, waba_id, access_token });
  const id = saveAccount({ id: int(b.id) || undefined, provider: 'whatsapp', label: b.label || p.verified_name || p.display_phone_number, identifier: phone_number_id, secret: { access_token },
    info: { phone_number_id, waba_id, display_phone_number: p.display_phone_number, verified_name: p.verified_name } });
  run("UPDATE accounts SET tested_at=datetime('now') WHERE id=?", id);
  logActivity({ event: 'account_connected', result: 'whatsapp', detail: `${p.verified_name} (${p.display_phone_number})` });
  return { ok: true, id, message: `Connected ${p.verified_name} (${p.display_phone_number})` };
});
route('POST', '/api/accounts/:id/test', async (req, res, p) => ({ ok: true, message: await testAccount(int(p.id)) }));
route('POST', '/api/accounts/:id/disconnect', (req, res, p) => {
  const a = getAccount(int(p.id)); if (!a) throw new HttpError(404, 'Not found');
  run("UPDATE accounts SET status='disconnected', secret=?, tested_at=NULL WHERE id=?", encryptJson({}), a.id);
  resolveAlert(`account:${a.id}`);
  logActivity({ event: 'account_disconnected', result: a.provider, detail: a.label });
  return { ok: true };
});
route('DELETE', '/api/accounts/:id', (req, res, p) => {
  const id = int(p.id);
  const used = all('SELECT name FROM shops WHERE gmail_account_id=? OR whatsapp_account_id=? OR sheet_account_id=?', id, id, id);
  if (used.length) bad(`Still used by: ${used.map((u) => u.name).join(', ')}. Choose another account for those shops first.`);
  run('DELETE FROM accounts WHERE id=?', id);
  return { ok: true };
});
route('GET', '/api/accounts/:id/wa-templates', async (req, res, p) => {
  const list = await listTemplates(int(p.id));
  return list.filter((t) => t.status === 'APPROVED');
});

// --- shops ---
route('POST', '/api/shops', async (req) => {
  const { name } = await json(req);
  const n = String(name || '').trim();
  if (!n) bad('Enter the business name');
  if (one('SELECT 1 FROM shops WHERE name = ? COLLATE NOCASE', n)) bad('A shop with this name already exists');
  // Shared accounts by default: the first connected Gmail/Google and WhatsApp account.
  const g = one("SELECT id FROM accounts WHERE provider='google' AND status!='disconnected' ORDER BY id LIMIT 1");
  const w = one("SELECT id FROM accounts WHERE provider='whatsapp' AND status!='disconnected' ORDER BY id LIMIT 1");
  const id = Number(run('INSERT INTO shops (name, gmail_account_id, whatsapp_account_id, settings) VALUES (?,?,?,?)', n, g?.id ?? null, w?.id ?? null, JSON.stringify(DEFAULT_SHOP_SETTINGS)).lastInsertRowid);
  run('INSERT INTO templates (shop_id, channel, data) VALUES (?,?,?)', id, 'email', JSON.stringify({
    subject: `Welcome to {{business_name}}`,
    body: `Hi {{name}},\n\nThank you for your interest in {{business_name}}. We're happy to have you!\n\nIf you have any questions, just reply to this email.\n\nBest regards,\n{{business_name}}`,
  }));
  logActivity({ shop_id: id, event: 'shop_created', result: 'ok', detail: n });
  return { ok: true, id };
});
route('GET', '/api/shops/:id', (req, res, p) => shopDetail(shopOr404(p.id)));
route('PATCH', '/api/shops/:id', async (req, res, p) => {
  const s = shopOr404(p.id);
  const b = await json(req);
  if (b.name !== undefined) { const n = String(b.name).trim(); if (!n) bad('Name cannot be empty'); run('UPDATE shops SET name=? WHERE id=?', n, s.id); }
  for (const k of ['gmail_account_id', 'whatsapp_account_id']) {
    if (b[k] !== undefined) {
      const id = int(b[k]);
      if (id) { const a = getAccount(id); if (!a || a.provider !== (k === 'gmail_account_id' ? 'google' : 'whatsapp')) bad('Wrong account type'); }
      run(`UPDATE shops SET ${k}=? WHERE id=?`, id, s.id);
    }
  }
  if (b.column_map !== undefined) {
    const allowed = [...FIELDS, ...STATUS_FIELDS].map((f) => f.key);
    const m = {};
    for (const k of allowed) if (b.column_map[k]) m[k] = String(b.column_map[k]).trim();
    for (const f of STATUS_FIELDS) if (!m[f.key]) m[f.key] = f.label;
    if (!m.email && !m.phone && !m.whatsapp) bad('Map at least an Email or a Phone/WhatsApp column');
    run('UPDATE shops SET column_map=? WHERE id=?', JSON.stringify(m), s.id);
  }
  if (b.settings !== undefined) {
    const st = { ...s.settings };
    const i = b.settings;
    if (i.channels !== undefined) { if (!['email', 'whatsapp', 'both'].includes(i.channels)) bad('Invalid channel choice'); st.channels = i.channels; }
    if (i.delay_minutes !== undefined) { const d = Number(i.delay_minutes); if (!(d >= 0 && d <= 10080)) bad('Delay must be between 0 and 10080 minutes (7 days)'); st.delay_minutes = Math.round(d); }
    if (i.schedule !== undefined) {
      const sc = { ...st.schedule, ...i.schedule };
      try { new Intl.DateTimeFormat('en', { timeZone: sc.tz }); } catch { bad('Unknown time zone'); }
      if (!/^\d{2}:\d{2}$/.test(sc.start) || !/^\d{2}:\d{2}$/.test(sc.end)) bad('Times must be HH:MM');
      sc.days = (sc.days || []).map(Number).filter((d) => d >= 0 && d <= 6);
      if (sc.enabled && !sc.days.length) bad('Choose at least one sending day');
      st.schedule = { enabled: !!sc.enabled, tz: sc.tz, days: sc.days, start: sc.start, end: sc.end };
    }
    if (i.conditions !== undefined) st.conditions = (i.conditions || []).filter((c) => c.column && CONDITION_OPS.includes(c.op)).map((c) => ({ column: String(c.column), op: c.op, value: String(c.value ?? '') }));
    if (i.consent !== undefined) st.consent = { required: !!i.consent.required, accepted: String(i.consent.accepted || DEFAULT_SHOP_SETTINGS.consent.accepted) };
    if (i.resend_on_edit !== undefined) st.resend_on_edit = !!i.resend_on_edit;
    if (i.campaign !== undefined) { const c = String(i.campaign).trim().slice(0, 60); if (!c) bad('Campaign name cannot be empty'); st.campaign = c; }
    if (i.default_country_code !== undefined) { const c = String(i.default_country_code).replace(/\D/g, ''); if (!c) bad('Country code required'); st.default_country_code = c; }
    run('UPDATE shops SET settings=? WHERE id=?', JSON.stringify(st), s.id);
    // Waiting messages were scheduled with the old timing — reschedule them.
    if (i.schedule !== undefined || i.delay_minutes !== undefined) run("UPDATE jobs SET next_attempt_at=? WHERE shop_id=? AND status='pending' AND attempts=0", Date.now(), s.id);
  }
  return shopDetail(getShop(s.id));
});
route('DELETE', '/api/shops/:id', (req, res, p) => {
  const s = shopOr404(p.id);
  for (const m of all('SELECT id FROM media WHERE shop_id=?', s.id)) media.deleteMedia(s.id, m.id);
  run('DELETE FROM shops WHERE id=?', s.id);
  run('DELETE FROM jobs WHERE shop_id=?', s.id);
  run("DELETE FROM suppression WHERE scope=?", String(s.id));
  logActivity({ event: 'shop_deleted', result: 'ok', detail: s.name });
  return { ok: true };
});

// --- spreadsheet connection ---
route('POST', '/api/shops/:id/sheet', async (req, res, p) => {
  const s = shopOr404(p.id);
  const b = await json(req);
  const provider = b.provider;
  if (!providers[provider]) bad('Choose Google Sheets, OneDrive Excel or Demo sheet');
  let accountId = null;
  if (provider !== 'demo') {
    accountId = int(b.account_id);
    const a = accountId ? getAccount(accountId) : null;
    if (!a || a.provider !== provider || a.status === 'disconnected') bad(`Select a connected ${provider === 'google' ? 'Google' : 'Microsoft'} account first`);
    if (!b.url) bad('Paste the spreadsheet link');
  }
  const r = await providers[provider].resolve(accountId, b.url);
  forgetFileCache(s.id);
  const tab = r.tabs.length === 1 ? r.tabs[0] : null;
  run(`UPDATE shops SET sheet_provider=?, sheet_account_id=?, sheet_ref=?, sheet_tab=?, sheet_status='ok', sheet_error=NULL, last_polled_at=NULL,
       baseline_test_done=0, baseline_live_done=0 WHERE id=?`, provider, accountId, JSON.stringify(r.ref), tab, s.id);
  run('DELETE FROM contacts_seen WHERE shop_id=?', s.id); // new sheet → new baseline
  run('DELETE FROM sheet_dirty WHERE shop_id=?', s.id);
  if (provider === 'demo' && !one('SELECT 1 FROM demo_sheets WHERE shop_id=?', s.id)) {
    setDemoRows(s.id, [['Name', 'Email', 'Phone Number', 'Consent Status'], ['Existing Customer', 'existing@example.com', '0501111111', 'Yes']]);
  }
  logActivity({ shop_id: s.id, event: 'sheet_connected', result: provider, detail: r.ref.title });
  const out = { ok: true, tabs: r.tabs, title: r.ref.title, file_mode: r.ref.mode === 'file' };
  if (tab) Object.assign(out, await chooseTab(getShop(s.id), tab, s.header_row));
  return out;
});
async function chooseTab(s, tab, headerRow) {
  run('UPDATE shops SET sheet_tab=?, header_row=? WHERE id=?', tab, headerRow || 1, s.id);
  const shop = getShop(s.id);
  const rows = await providers[shop.sheet_provider].read(shop);
  const headers = (rows[(shop.header_row || 1) - 1] || []).map((h) => String(h || '').trim()).filter(Boolean);
  if (!headers.length) return { headers, warning: `Row ${shop.header_row} of "${tab}" is empty. Put your column titles (Name, Email, Phone Number…) in that row.` };
  const current = shop.column_map;
  const keep = Object.keys(current).length && Object.entries(current).every(([k, v]) => STATUS_FIELDS.some((f) => f.key === k) || headers.includes(v));
  const map = keep ? current : autoMap(headers);
  run('UPDATE shops SET column_map=? WHERE id=?', JSON.stringify(map), s.id);
  return { headers, column_map: map };
}
route('POST', '/api/shops/:id/sheet/tab', async (req, res, p) => {
  const s = shopOr404(p.id);
  const b = await json(req);
  const hr = int(b.header_row) || 1;
  if (hr < 1 || hr > 50) bad('Header row must be between 1 and 50');
  run('UPDATE shops SET baseline_test_done=0, baseline_live_done=0 WHERE id=? AND (sheet_tab IS NOT ? OR header_row != ?)', s.id, b.tab, hr);
  if (getShop(s.id).baseline_live_done === 0) { run('DELETE FROM contacts_seen WHERE shop_id=?', s.id); }
  return { ok: true, ...(await chooseTab(s, String(b.tab), hr)) };
});
route('GET', '/api/shops/:id/sheet/tabs', async (req, res, p) => {
  const s = shopOr404(p.id);
  if (!s.sheet_provider) return { tabs: [] };
  if (s.sheet_provider === 'demo') return { tabs: ['Sheet1'] };
  const r = await providers[s.sheet_provider].resolve(s.sheet_account_id, s.sheet_ref.url);
  return { tabs: r.tabs };
});
route('GET', '/api/shops/:id/sheet/preview', async (req, res, p) => {
  const s = shopOr404(p.id);
  if (!s.sheet_provider || !s.sheet_tab) return { headers: [], rows: [] };
  const rows = await providers[s.sheet_provider].read(s);
  const hIdx = (s.header_row || 1) - 1;
  const headers = (rows[hIdx] || []).map((h) => String(h || '').trim());
  return { headers, rows: rows.slice(hIdx + 1).slice(-15), total: Math.max(0, rows.length - hIdx - 1), first_row_number: Math.max(hIdx + 2, rows.length - 14) };
});
route('POST', '/api/shops/:id/sheet/disconnect', (req, res, p) => {
  const s = shopOr404(p.id);
  run(`UPDATE shops SET sheet_provider=NULL, sheet_account_id=NULL, sheet_ref='{}', sheet_tab=NULL, sheet_status='not_connected', sheet_error=NULL, status='paused' WHERE id=?`, s.id);
  forgetFileCache(s.id);
  logActivity({ shop_id: s.id, event: 'sheet_disconnected', result: 'ok' });
  return { ok: true };
});
route('POST', '/api/shops/:id/demo-rows', async (req, res, p) => {
  const s = shopOr404(p.id);
  if (s.sheet_provider !== 'demo') bad('This shop is not using the demo sheet');
  const b = await json(req);
  const rows = await providers.demo.read(s);
  const headers = rows[(s.header_row || 1) - 1] || [];
  const row = headers.map((h) => String(b.values?.[h] ?? ''));
  rows.push(row);
  setDemoRows(s.id, rows);
  run('UPDATE shops SET last_polled_at=NULL WHERE id=?', s.id); // check soon
  return { ok: true };
});

// --- templates & previews ---
route('GET', '/api/shops/:id/templates', (req, res, p) => {
  const s = shopOr404(p.id);
  return { email: getTemplate(s.id, 'email') || {}, whatsapp: getTemplate(s.id, 'whatsapp') || {}, tested: s.settings.tested || {}, channels: enabledChannels(s) };
});
route('PUT', '/api/shops/:id/templates/:channel', async (req, res, p) => {
  const s = shopOr404(p.id);
  const b = await json(req);
  let data;
  if (p.channel === 'email') {
    if (!String(b.subject || '').trim()) bad('Enter an email subject');
    if (!String(b.body || '').trim()) bad('Enter the email message');
    data = { subject: String(b.subject).slice(0, 250), body: String(b.body).slice(0, 20000) };
  } else if (p.channel === 'whatsapp') {
    if (!b.template_name) bad('Choose an approved WhatsApp template');
    const t = b.template || {};
    data = {
      template_name: String(b.template_name), language: String(b.language || t.language || 'en'),
      category: t.category || b.category || '', parameter_format: t.parameter_format || b.parameter_format || 'POSITIONAL',
      header_format: t.header_format || b.header_format || 'NONE', body_text: t.body_text || b.body_text || '',
      body_param_names: t.body_param_names || b.body_param_names || [],
      body_params: (b.body_params || []).map(String), header_text_params: (b.header_text_params || []).map(String),
      header_media_id: int(b.header_media_id), url_buttons: (b.url_buttons || []).map((x) => ({ index: Number(x.index), expr: String(x.expr || '') })),
    };
    const need = t.body_params ?? data.body_params.length;
    if (data.body_params.length !== need || data.body_params.some((x) => !x.trim())) bad(`This template has ${need} variable(s). Fill in every one.`);
    if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(data.header_format)) {
      const m = data.header_media_id ? media.getMedia(s.id, data.header_media_id) : null;
      if (!m) bad(`This template needs a ${data.header_format.toLowerCase()} in its header. Upload it on the Attachments page, then choose it here.`);
      const sup = media.whatsappSupport(m);
      if (!sup.ok || sup.type !== data.header_format.toLowerCase()) bad(`"${m.filename}" can't be used as the ${data.header_format.toLowerCase()} header (${sup.reason || 'wrong file type'}).`);
    }
  } else bad('Unknown channel');
  run("INSERT INTO templates (shop_id, channel, data, updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(shop_id, channel) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at", s.id, p.channel, JSON.stringify(data));
  // A changed template must be tested again before going live.
  const st = s.settings; if (st.tested?.[p.channel]) { delete st.tested[p.channel]; run('UPDATE shops SET settings=? WHERE id=?', JSON.stringify(st), s.id); }
  resolveAlert(`template:${s.id}:${p.channel}`);
  run("UPDATE jobs SET status='pending', next_attempt_at=? WHERE shop_id=? AND channel=? AND status='blocked' AND error_kind='config'", Date.now(), s.id, p.channel);
  return { ok: true };
});
route('POST', '/api/shops/:id/preview/:channel', async (req, res, p) => {
  const s = shopOr404(p.id);
  const b = await json(req);
  const rec = await sampleRecord(s);
  if (p.channel === 'email') {
    const c = composeEmail(s, rec, { subject: b.subject || '', body: b.body || '' }, getSetting('owner_email', '') || 'you@example.com');
    return { subject: c.subject, text: c.text, footer: `${s.name} · Unsubscribe`, attachments: c.attach.map((m) => m.filename), links: c.links, sample: rec.fields };
  }
  const c = composeWhatsApp(s, rec, { body_params: b.body_params || [], header_text_params: b.header_text_params || [], url_buttons: b.url_buttons || [], header_media_id: int(b.header_media_id) }, null);
  let text = String(b.body_text || '');
  const names = b.body_param_names || [];
  c.bodyParams.forEach((v, i) => { text = text.replace(new RegExp(`\\{\\{\\s*${names[i] || i + 1}\\s*\\}\\}`, 'g'), v); });
  return { text, params: c.bodyParams, header_media: c.headerMedia?.filename || null, notes: c.notes, sample: rec.fields };
});
route('POST', '/api/shops/:id/test/:channel', async (req, res, p) => {
  const s = shopOr404(p.id);
  if (!['email', 'whatsapp'].includes(p.channel)) bad('Unknown channel');
  return { ok: true, ...(await testSend(s.id, p.channel)) };
});

// --- media ---
route('GET', '/api/shops/:id/media', (req, res, p) => {
  const s = shopOr404(p.id);
  return { items: media.listMedia(s.id), selection: { email: media.selection(s.id, 'email').map((m) => m.id), whatsapp: media.selection(s.id, 'whatsapp').map((m) => m.id) }, email_limit_mb: config.emailAttachmentLimitBytes / 1048576 };
});
route('POST', '/api/shops/:id/media', async (req, res, p) => {
  const s = shopOr404(p.id);
  const url = new URL(req.url, 'http://x');
  const filename = url.searchParams.get('filename');
  if (!filename) bad('Missing file name');
  const len = Number(req.headers['content-length'] || 0);
  if (len > config.maxUploadBytes) throw new HttpError(413, `File is larger than ${config.maxUploadBytes / 1048576} MB`);
  const tmp = path.join(media.MEDIA_DIR, `.upload-${randomId(8)}`);
  let size = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    req.on('data', (c) => { size += c.length; if (size > config.maxUploadBytes) { req.destroy(); out.destroy(); reject(new HttpError(413, 'File too large')); } });
    req.pipe(out); out.on('finish', resolve); out.on('error', reject); req.on('error', reject);
  }).catch((e) => { fs.rmSync(tmp, { force: true }); throw e; });
  if (!size) { fs.rmSync(tmp, { force: true }); bad('The file is empty'); }
  const type = String(req.headers['content-type'] || '').split(';')[0];
  const mime = type && type !== 'application/octet-stream' ? type : media.mimeFor(filename);
  const id = media.storeUpload(s.id, filename, mime === 'audio/opus' ? 'audio/ogg' : mime, tmp, size);
  logActivity({ shop_id: s.id, event: 'media_uploaded', result: 'ok', detail: filename });
  return { ok: true, id };
});
route('POST', '/api/shops/:id/media/link', async (req, res, p) => {
  const s = shopOr404(p.id); const b = await json(req);
  return { ok: true, id: media.addLink(s.id, String(b.title || '').trim(), String(b.url || '').trim()) };
});
route('DELETE', '/api/shops/:id/media/:mid', (req, res, p) => {
  const s = shopOr404(p.id);
  const inTpl = getTemplate(s.id, 'whatsapp');
  if (inTpl?.header_media_id === int(p.mid)) bad('This file is the header of your WhatsApp template. Choose another header first.');
  media.deleteMedia(s.id, int(p.mid)); return { ok: true };
});
route('PUT', '/api/shops/:id/media/selection/:channel', async (req, res, p) => {
  const s = shopOr404(p.id); const b = await json(req);
  if (!['email', 'whatsapp'].includes(p.channel)) bad('Unknown channel');
  media.setSelection(s.id, p.channel, (b.ids || []).map(Number));
  return { ok: true };
});

// --- automation controls ---
route('GET', '/api/shops/:id/readiness', (req, res, p) => ({ problems: liveReadiness(shopOr404(p.id)) }));
route('POST', '/api/shops/:id/start', async (req, res, p) => {
  const s = shopOr404(p.id);
  const b = await json(req);
  const mode = b.mode === 'live' ? 'live' : 'test';
  if (!s.sheet_provider || !s.sheet_tab) bad('Connect a spreadsheet and choose the tab first');
  if (!s.column_map.email && !s.column_map.phone && !s.column_map.whatsapp) bad('Map your columns first (shop settings)');
  if (mode === 'live') { const pr = liveReadiness(s); if (pr.length) bad('Not ready to go live:\n• ' + pr.join('\n• ')); }
  if (s.mode !== mode) {
    run("UPDATE jobs SET status='skipped', error_kind='mode_changed', last_error=? WHERE shop_id=? AND mode!=? AND status IN ('pending','blocked')", `Cancelled: switched to ${mode} mode`, s.id, mode);
    run('DELETE FROM sheet_dirty WHERE shop_id=? AND mode!=?', s.id, mode);
  }
  const col = mode === 'live' ? 'baseline_live_done' : 'baseline_test_done';
  if (b.include_existing) run(`UPDATE shops SET ${col}=1 WHERE id=?`, s.id);
  run("UPDATE shops SET status='active', mode=?, last_polled_at=NULL WHERE id=?", mode, s.id);
  logActivity({ shop_id: s.id, event: 'automation_started', result: mode, detail: b.include_existing ? 'Including rows already in the sheet' : 'Only new rows' });
  // Record the "already in the sheet" rows right now, so the cut-off is the moment Start was clicked
  // (a row added a few seconds later is treated as new and gets messaged).
  if (!getShop(s.id)[col]) {
    const r = await pollShop(s.id).catch((e) => ({ ok: false, error: e.message }));
    if (r.ok === false) logActivity({ shop_id: s.id, event: 'sheet_error', result: 'start', detail: r.error });
  }
  return shopDetail(getShop(s.id));
});
route('POST', '/api/shops/:id/pause', (req, res, p) => {
  const s = shopOr404(p.id);
  run("UPDATE shops SET status='paused' WHERE id=?", s.id);
  logActivity({ shop_id: s.id, event: 'automation_paused', result: 'ok' });
  return shopDetail(getShop(s.id));
});
route('POST', '/api/shops/:id/check-now', async (req, res, p) => {
  const s = shopOr404(p.id);
  const r = await pollShop(s.id, { flushOnly: s.status !== 'active' || !!getSetting('global_paused', false) });
  return r;
});
route('POST', '/api/shops/:id/retry', async (req, res, p) => {
  const s = shopOr404(p.id); const b = await json(req);
  return { ok: true, count: retryJobs(s.id, b.job_ids || null) };
});

// --- opt-outs ---
route('GET', '/api/optouts', (req) => {
  const shop = new URL(req.url, 'http://x').searchParams.get('shop');
  return shop ? all("SELECT * FROM suppression WHERE scope=? ORDER BY id DESC", String(int(shop))) : all("SELECT * FROM suppression WHERE scope='global' ORDER BY id DESC");
});
route('POST', '/api/optouts', async (req) => {
  const b = await json(req);
  const scope = b.scope === 'global' ? 'global' : String(int(b.scope));
  if (scope !== 'global' && !getShop(int(scope))) bad('Shop not found');
  const channel = ['all', 'email', 'whatsapp'].includes(b.channel) ? b.channel : 'all';
  const v = addSuppression(scope, channel, b.value, b.reason || 'Added manually');
  logActivity({ shop_id: scope === 'global' ? null : int(scope), event: 'opted_out', result: scope === 'global' ? 'global' : 'shop', detail: 'Added manually' });
  return { ok: true, value: v };
});
route('DELETE', '/api/optouts/:id', (req, res, p) => { run('DELETE FROM suppression WHERE id=?', int(p.id)); return { ok: true }; });

// --- activity ---
route('GET', '/api/activity', (req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const where = [], args = [];
  if (q.get('shop')) { where.push('a.shop_id=?'); args.push(int(q.get('shop'))); }
  if (q.get('channel')) { where.push('a.channel=?'); args.push(q.get('channel')); }
  if (q.get('event')) { where.push('a.event=?'); args.push(q.get('event')); }
  if (q.get('before')) { where.push('a.id<?'); args.push(int(q.get('before'))); }
  return all(`SELECT a.*, s.name shop_name FROM activity a LEFT JOIN shops s ON s.id=a.shop_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT 100`, ...args);
});
route('GET', '/api/jobs', (req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const shop = getShop(int(q.get('shop')));
  if (!shop) bad('Choose a shop');
  const st = q.get('status');
  const rows = all(`SELECT id, channel, mode, status, error_kind, last_error, attempts, recipient, row_number, simulated, sent_at, next_attempt_at, created_at
    FROM jobs WHERE shop_id=? ${st ? 'AND status=?' : ''} ORDER BY id DESC LIMIT 200`, ...(st ? [shop.id, st] : [shop.id]));
  return rows.map((j) => ({ ...j, recipient: j.channel === 'email' ? (j.recipient || '').replace(/^(.{2}).*@/, '$1***@') : (j.recipient || '').replace(/^(\+\d{4})\d+(\d{3})$/, '$1****$2'), status_text: statusText(j, shop.settings.schedule.tz), sent_local: formatLocal(j.sent_at, shop.settings.schedule.tz) }));
});
route('GET', '/api/meta', () => ({ fields: FIELDS.map(({ key, label }) => ({ key, label })), status_fields: STATUS_FIELDS, condition_ops: CONDITION_OPS }));

// ---------- OAuth ----------
function startOAuth(provider, res, returnTo) {
  const state = randomId(16);
  run('INSERT INTO oauth_states (state, provider, data, created_at) VALUES (?,?,?,?)', state, provider, JSON.stringify({ returnTo }), Date.now());
  run('DELETE FROM oauth_states WHERE created_at < ?', Date.now() - 3600000);
  res.writeHead(302, { location: provider === 'google' ? googleAuthUrl(state) : microsoftAuthUrl(state) }); res.end();
}
async function finishOAuth(provider, req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  const st = one('SELECT * FROM oauth_states WHERE state=? AND provider=?', q.get('state'), provider);
  run('DELETE FROM oauth_states WHERE state=?', q.get('state'));
  const back = (msg, ok) => { res.writeHead(302, { location: `/#/connections?${ok ? 'ok' : 'error'}=${encodeURIComponent(msg)}` }); res.end(); };
  if (!st || Date.now() - st.created_at > 3600000) return back('Sign-in expired. Please try again.', false);
  if (q.get('error')) return back(`${provider === 'google' ? 'Google' : 'Microsoft'} sign-in was cancelled: ${q.get('error_description') || q.get('error')}`, false);
  try {
    const r = provider === 'google' ? await googleExchange(q.get('code')) : await microsoftExchange(q.get('code'));
    const reconnect = int(JSON.parse(st.data).returnTo);
    const id = saveAccount({ id: reconnect || undefined, provider, label: r.email, identifier: r.email, secret: r.secret });
    try { await testAccount(id); } catch { /* shown on the page */ }
    // Shops without a Gmail account get this shared one.
    if (provider === 'google') run('UPDATE shops SET gmail_account_id=? WHERE gmail_account_id IS NULL', id);
    logActivity({ event: 'account_connected', result: provider, detail: r.email });
    back(`Connected ${r.email}`, true);
  } catch (e) { back(e.message, false); }
}

// ---------- public pages: unsubscribe, files, webhook ----------
function unsubscribePage(req, res, token, done) {
  const p = verify(token);
  if (!p) return send(res, 400, simplePage('Link not valid', '<h1>This link is not valid</h1><p>Please contact the business directly.</p>'));
  const shop = getShop(p.s);
  const name = esc(shop?.name || 'this business');
  if (done) return send(res, 200, simplePage('Unsubscribed', `<h1>You're unsubscribed</h1><p>${done === 'global' ? 'You will not receive emails from any of these businesses again.' : `You will not receive more emails from <b>${name}</b>.`}</p>`));
  send(res, 200, simplePage('Unsubscribe', `<h1>Unsubscribe</h1><p>Stop receiving emails from <b>${name}</b> at <b>${esc(p.v)}</b>?</p>
    <form method="post"><input type="hidden" name="scope" value="shop"><button type="submit">Unsubscribe from ${name}</button></form>
    <form method="post"><input type="hidden" name="scope" value="global"><button type="submit" class="secondary">Unsubscribe from all businesses</button></form>`));
}
async function unsubscribePost(req, res, token) {
  const p = verify(token);
  if (!p) return send(res, 400, simplePage('Link not valid', '<h1>This link is not valid</h1>'));
  const body = (await readBody(req, 10000)).toString('utf8');
  const form = new URLSearchParams(body);
  // One-click (RFC 8058) sends "List-Unsubscribe=One-Click" → shop-level opt-out.
  const scope = form.get('scope') === 'global' ? 'global' : String(p.s);
  try { addSuppression(scope, p.c || 'email', p.v, scope === 'global' ? 'Unsubscribed from all (email link)' : 'Unsubscribed (email link)'); } catch { /* invalid address */ }
  logActivity({ shop_id: scope === 'global' ? null : p.s, channel: p.c, contact_ref: String(p.v).replace(/^(.{2}).*@/, '$1***@'), event: 'opted_out', result: scope === 'global' ? 'global' : 'shop', detail: 'Unsubscribe link' });
  if (form.get('List-Unsubscribe') === 'One-Click') return send(res, 200, { ok: true });
  unsubscribePage(req, res, token, scope === 'global' ? 'global' : 'shop');
}
function serveFile(req, res, token) {
  const p = verify(token);
  const m = p ? media.getMedia(p.s, p.m) : null;
  if (!m || m.kind !== 'file') return send(res, 404, simplePage('Not found', '<h1>This download link has expired</h1><p>Please contact the business for a new link.</p>'));
  const file = media.mediaPath(m);
  if (!fs.existsSync(file)) return send(res, 404, simplePage('Not found', '<h1>File no longer available</h1>'));
  res.writeHead(200, { 'content-type': m.mime, 'content-length': fs.statSync(file).size, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(m.filename)}`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=3600' });
  fs.createReadStream(file).pipe(res);
}
async function webhook(req, res) {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET') {
    if (url.searchParams.get('hub.mode') === 'subscribe' && config.meta.verifyToken && safeEqual(url.searchParams.get('hub.verify_token') || '', config.meta.verifyToken)) {
      res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(url.searchParams.get('hub.challenge'));
    }
    res.writeHead(403); return res.end();
  }
  const raw = await readBody(req, 5 * 1024 * 1024);
  if (!config.meta.appSecret) { res.writeHead(503); return res.end('META_APP_SECRET not set'); }
  const sig = String(req.headers['x-hub-signature-256'] || '');
  const expect = 'sha256=' + crypto.createHmac('sha256', config.meta.appSecret).update(raw).digest('hex');
  if (!sig || sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) { res.writeHead(401); return res.end(); }
  res.writeHead(200); res.end('ok');
  try { handleWebhook(JSON.parse(raw.toString('utf8'))); } catch (e) { console.error('webhook error', e.message); }
}

// ---------- static files ----------
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/favicon.svg': 'favicon.svg' };
const CT = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };
const SEC_HEADERS = {
  'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'",
};

// ---------- main handler ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pth = url.pathname;
  try {
    if (pth === '/healthz') return send(res, 200, { ok: true, worker_online: Date.now() - getSetting('worker_heartbeat', 0) < 60000 });
    if (pth === '/webhooks/whatsapp') return await webhook(req, res);
    if (pth.startsWith('/u/')) return req.method === 'POST' ? await unsubscribePost(req, res, pth.slice(3)) : unsubscribePage(req, res, pth.slice(3));
    if (pth.startsWith('/f/')) return serveFile(req, res, pth.slice(3));
    if (req.method === 'GET' && STATIC[pth]) {
      const f = STATIC[pth];
      res.writeHead(200, { 'content-type': CT[f.split('.').pop()], 'cache-control': f === 'index.html' ? 'no-store' : 'no-cache', ...SEC_HEADERS });
      return fs.createReadStream(path.join(PUBLIC, f)).pipe(res);
    }
    if (pth.startsWith('/oauth/')) {
      if (!authed(req)) { res.writeHead(302, { location: '/' }); return res.end(); }
      const [, , provider, step] = pth.split('/');
      if (!['google', 'microsoft'].includes(provider)) throw new HttpError(404, 'Not found');
      if (provider === 'google' && !googleEnabled()) throw new HttpError(400, 'Google is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). See SETUP.md');
      if (provider === 'microsoft' && !microsoftEnabled()) throw new HttpError(400, 'Microsoft is not configured (MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET). See SETUP.md');
      if (step === 'start') return startOAuth(provider, res, url.searchParams.get('reconnect'));
      if (step === 'callback') return await finishOAuth(provider, req, res);
      throw new HttpError(404, 'Not found');
    }
    if (pth.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = pth.match(r.re);
        if (!m) continue;
        if (!r.public && !authed(req)) throw new HttpError(401, 'Please sign in');
        // CSRF protection: state-changing API calls must come from our own page (custom header can't be sent cross-site).
        if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'sheetsender') throw new HttpError(403, 'Forbidden');
        const out = await r.handler(req, res, Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)])));
        if (!res.headersSent && out !== undefined) send(res, 200, out);
        return;
      }
      throw new HttpError(404, 'Not found');
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    // HttpError → its own status; provider/validation errors (have .kind or a plain message) → 400.
    const status = e instanceof HttpError ? e.status : 400;
    if (!(e instanceof HttpError) && !e.kind) console.error(e.stack || e);
    if (!res.headersSent) {
      if (pth.startsWith('/api/')) send(res, status, { error: e.message || 'Something went wrong' });
      else send(res, status, simplePage('Error', `<h1>Something went wrong</h1><p>${esc(e.message)}</p><p><a href="/">Back to dashboard</a></p>`));
    }
  }
});
server.requestTimeout = 15 * 60000;
server.listen(config.port, config.host, () => console.log(`SheetSender web app on ${config.baseUrl} (port ${config.port})`));
