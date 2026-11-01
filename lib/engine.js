// Processing engine shared by the background worker and the web server.
//  - pollShop():   reads one shop's spreadsheet, detects new/edited rows, creates idempotent jobs, writes statuses back
//  - processJob(): sends one email or WhatsApp message (or a clearly labelled simulation)
//  - handleWebhook(): WhatsApp delivery updates and STOP replies
import { config } from './config.js';
import { one, all, run, getShop, getSetting, getTemplate, logActivity, raiseAlert, resolveAlert, iso } from './db.js';
import { FIELDS, statusHeaderNames, rowToRecord, contactIdentity, contentHash, normalizeEmail, normalizePhone,
  consentOk, conditionsOk, buildVars, renderTemplate, maskRecipient, STATUS_FIELDS } from './contacts.js';
import { providerFor, indexToCol } from './sheets.js';
import { getAccount, accountReady, markAccountProblem, getAccessToken, testAccount } from './accounts.js';
import { selection, downloadLink, whatsappSupport, getMedia } from './media.js';
import { planAttachments, buildMime, sendEmail } from './gmail.js';
import * as wa from './whatsapp.js';
import { sign } from './crypto.js';

export const CHANNELS = ['email', 'whatsapp'];
const BACKOFF_MIN = [1, 5, 15, 60, 180];
export const MAX_ATTEMPTS = 5;

export const enabledChannels = (shop) => (shop.settings.channels === 'both' ? CHANNELS : [shop.settings.channels]);
export const globalPaused = () => !!getSetting('global_paused', false);
export const ownerContacts = () => ({ email: normalizeEmail(getSetting('owner_email', '')), phone: normalizePhone(getSetting('owner_phone', ''), '971') });

// ---------- schedule ----------
function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const toMin = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
export function inWindow(schedule, ms = Date.now()) {
  if (!schedule?.enabled) return true;
  const { day, minutes } = localParts(ms, schedule.tz || 'Asia/Dubai');
  if (!(schedule.days || []).includes(day)) return false;
  const s = toMin(schedule.start), e = toMin(schedule.end);
  return s <= e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}
export function nextWindow(schedule, from = Date.now()) {
  if (!schedule?.enabled || inWindow(schedule, from)) return from;
  const step = 5 * 60000;
  let t = Math.ceil(from / step) * step;
  for (let i = 0; i < (8 * 24 * 60) / 5; i++, t += step) if (inWindow(schedule, t)) return t;
  return from + 86400000;
}
export function formatLocal(ms, tz = 'Asia/Dubai') {
  if (!ms) return '';
  const d = new Date(typeof ms === 'string' ? ms.replace(' ', 'T') + (ms.endsWith('Z') ? '' : 'Z') : ms);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d).replace(',', '');
}

// ---------- eligibility ----------
function isSuppressed(shopId, channel, recipient) {
  return !!one(`SELECT 1 FROM suppression WHERE value = ? AND channel IN ('all', ?) AND scope IN ('global', ?)`, recipient, channel, String(shopId));
}
function recipientFor(shop, channel, fields) {
  const raw = channel === 'email' ? fields.email : (fields.whatsapp || fields.phone);
  const norm = channel === 'email' ? normalizeEmail(raw) : normalizePhone(raw, shop.settings.default_country_code);
  return { raw: String(raw || '').trim(), norm };
}
// Returns null if the message may be sent, otherwise the final status to record.
export function evaluate(shop, channel, rec) {
  const { raw, norm } = recipientFor(shop, channel, rec.fields);
  if (!raw) return { status: 'skipped', kind: 'no_address', reason: channel === 'email' ? 'No email address' : 'No phone / WhatsApp number' };
  if (!norm) return { status: 'invalid', kind: 'invalid', reason: channel === 'email' ? `Invalid email "${raw}"` : `Invalid phone number "${raw}"` };
  if (isSuppressed(shop.id, channel, norm)) return { status: 'opted_out', kind: 'opted_out', reason: 'Contact has opted out' };
  const c = consentOk(shop.settings, rec.fields, shop.column_map);
  if (!c.ok) return { status: 'skipped', kind: c.kind, reason: c.reason };
  const r = conditionsOk(shop.settings.conditions, rec.columns);
  if (!r.ok) return { status: 'skipped', kind: 'condition', reason: r.reason };
  return null;
}

const dirty = (shopId, mode, identity) => run('INSERT OR IGNORE INTO sheet_dirty (shop_id, mode, row_identity) VALUES (?,?,?)', shopId, mode, identity);
export const flushSoon = new Set();

function createJob(shop, channel, identity, rowNumber, rec, revision) {
  const mode = shop.mode, campaign = shop.settings.campaign || 'welcome';
  const { norm } = recipientFor(shop, channel, rec.fields);
  const base = `${shop.id}|${mode}|${campaign}|${channel}`;
  const key = `${base}|${norm || 'row:' + identity}|${revision}`;
  const ev = evaluate(shop, channel, rec);
  const due = nextWindow(shop.settings.schedule, Date.now() + (Number(shop.settings.delay_minutes) || 0) * 60000);
  const payload = JSON.stringify(rec);
  const ins = run(`INSERT OR IGNORE INTO jobs (shop_id, channel, mode, campaign, recipient, idem_key, row_identity, row_number, payload, status, error_kind, last_error, next_attempt_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    shop.id, channel, mode, campaign, norm, key, identity, rowNumber, payload,
    ev ? ev.status : 'pending', ev?.kind || null, ev?.reason || null, due);
  if (ins.changes === 0) {
    const existing = one('SELECT row_identity, row_number FROM jobs WHERE idem_key = ?', key);
    if (existing && existing.row_identity !== identity) {
      // Same recipient already handled for this shop + campaign + channel → never send twice.
      run(`INSERT OR IGNORE INTO jobs (shop_id, channel, mode, campaign, recipient, idem_key, row_identity, row_number, payload, status, error_kind, last_error, next_attempt_at)
           VALUES (?,?,?,?,?,?,?,?,?,'skipped','duplicate',?,0)`,
        shop.id, channel, mode, campaign, norm, `${key}|dup:${identity}`, identity, rowNumber, payload, `Already messaged (spreadsheet row ${existing.row_number})`);
      logActivity({ shop_id: shop.id, channel, contact_ref: `${maskRecipient(channel, norm)} (row ${rowNumber})`, event: 'skipped', result: 'duplicate', detail: `Same contact as row ${existing.row_number}` });
    }
  } else {
    logActivity({ shop_id: shop.id, job_id: Number(ins.lastInsertRowid), channel, contact_ref: `${maskRecipient(channel, norm) || '—'} (row ${rowNumber})`,
      event: ev ? ev.status : 'queued', result: ev?.kind || (due > Date.now() + 1000 ? 'scheduled' : 'pending'), detail: ev?.reason || (due > Date.now() + 1000 ? `Scheduled for ${formatLocal(due, shop.settings.schedule.tz)}` : null) });
  }
  dirty(shop.id, mode, identity);
}

function handleEdit(shop, identity, rowNumber, rec, hash) {
  const payload = JSON.stringify(rec);
  for (const channel of enabledChannels(shop)) {
    const jobs = all('SELECT * FROM jobs WHERE shop_id=? AND mode=? AND row_identity=? AND channel=? ORDER BY id DESC', shop.id, shop.mode, identity, channel);
    const sent = jobs.find((j) => ['sent', 'delivered', 'read'].includes(j.status));
    const open = jobs.find((j) => ['pending', 'blocked'].includes(j.status));
    const notSent = jobs.find((j) => ['skipped', 'invalid', 'opted_out'].includes(j.status) && j.error_kind !== 'duplicate');
    if (open) { run("UPDATE jobs SET payload=?, row_number=?, updated_at=datetime('now') WHERE id=?", payload, rowNumber, open.id); continue; }
    if (sent) {
      if (shop.settings.resend_on_edit) createJob(shop, channel, identity, rowNumber, rec, hash.slice(0, 12));
      continue;
    }
    if (notSent) {
      // Nothing was ever sent for this row; re-check it with the corrected data (e.g. consent changed to Yes).
      const ev = evaluate(shop, channel, rec);
      const { norm } = recipientFor(shop, channel, rec.fields);
      if (norm && norm !== notSent.recipient) { createJob(shop, channel, identity, rowNumber, rec, 0); continue; }
      run(`UPDATE jobs SET payload=?, row_number=?, status=?, error_kind=?, last_error=?, next_attempt_at=?, updated_at=datetime('now') WHERE id=?`,
        payload, rowNumber, ev ? ev.status : 'pending', ev?.kind || null, ev?.reason || null,
        nextWindow(shop.settings.schedule, Date.now() + (Number(shop.settings.delay_minutes) || 0) * 60000), notSent.id);
      if (!ev) logActivity({ shop_id: shop.id, job_id: notSent.id, channel, contact_ref: `row ${rowNumber}`, event: 'queued', result: 'row_edited', detail: 'Row was edited and is now eligible' });
      dirty(shop.id, shop.mode, identity);
      continue;
    }
    if (!jobs.length) createJob(shop, channel, identity, rowNumber, rec, 0); // channel enabled later
  }
}

// ---------- polling ----------
const pollFailures = new Map();
export async function pollShop(shopId, { flushOnly = false } = {}) {
  const shop = getShop(shopId);
  if (!shop || !shop.sheet_provider || !shop.sheet_tab) return { skipped: true };
  const provider = providerFor(shop);
  let rows;
  try { rows = await provider.read(shop); }
  catch (e) { return pollFailed(shop, e); }

  const hIdx = (shop.header_row || 1) - 1;
  const headers = (rows[hIdx] || []).map((h) => String(h || '').trim());
  if (!headers.some(Boolean)) return pollFailed(shop, new Error(`Header row ${shop.header_row} is empty. Check the header row number on the shop settings page.`));
  const map = shop.column_map;
  const missing = FIELDS.filter((f) => map[f.key] && !headers.includes(map[f.key])).map((f) => `"${map[f.key]}"`);
  if (missing.length) return pollFailed(shop, new Error(`Mapped column(s) ${missing.join(', ')} not found in the header row. Update the column mapping.`));

  const statusHeaders = statusHeaderNames(map);
  const mode = shop.mode;
  const baselineCol = mode === 'live' ? 'baseline_live_done' : 'baseline_test_done';
  const baselineDone = !!shop[baselineCol];
  const seen = new Map(all('SELECT identity, content_hash, baseline FROM contacts_seen WHERE shop_id=? AND mode=?', shop.id, mode).map((r) => [r.identity, r]));
  const located = new Map();
  const dupCells = [];
  let created = 0, baselined = 0;

  for (let r = hIdx + 1; r < rows.length; r++) {
    const rec = rowToRecord(headers, rows[r] || [], map);
    const identity = contactIdentity(rec.fields, shop.settings.default_country_code);
    if (!identity) continue;
    const rowNumber = r + 1;
    if (located.has(identity)) { dupCells.push({ rowNumber, first: located.get(identity).rowNumber, rec }); continue; }
    located.set(identity, { rowNumber, rec });
    if (flushOnly) continue;
    const hash = contentHash(rec.columns, statusHeaders);
    const s = seen.get(identity);
    if (!s) {
      run('INSERT OR IGNORE INTO contacts_seen (shop_id, mode, identity, content_hash, row_number, baseline) VALUES (?,?,?,?,?,?)', shop.id, mode, identity, hash, rowNumber, baselineDone ? 0 : 1);
      if (baselineDone) { for (const ch of enabledChannels(shop)) createJob(shop, ch, identity, rowNumber, rec, 0); created++; }
      else baselined++;
    } else if (s.content_hash !== hash) {
      run('UPDATE contacts_seen SET content_hash=?, row_number=? WHERE shop_id=? AND mode=? AND identity=?', hash, rowNumber, shop.id, mode, identity);
      if (!s.baseline) handleEdit(shop, identity, rowNumber, rec, hash);
    }
  }
  if (!flushOnly && !baselineDone) {
    run(`UPDATE shops SET ${baselineCol}=1 WHERE id=?`, shop.id);
    logActivity({ shop_id: shop.id, event: 'baseline', result: mode, detail: `${baselined} row(s) already in the sheet were recorded and will NOT be messaged. Only rows added from now on will be processed.` });
  }

  // ---- write statuses back to the sheet ----
  try {
    const cells = buildStatusCells(shop, headers, located, dupCells);
    if (cells.length) await provider.write(shop, cells);
    run('DELETE FROM sheet_dirty WHERE shop_id=? AND row_identity IN (SELECT value FROM json_each(?))', shop.id, JSON.stringify(cells.__identities || []));
    // Rows that were deleted from the sheet can't be updated — drop them.
    for (const d of all('SELECT row_identity FROM sheet_dirty WHERE shop_id=?', shop.id)) if (!located.has(d.row_identity)) run('DELETE FROM sheet_dirty WHERE shop_id=? AND row_identity=?', shop.id, d.row_identity);
  } catch (e) {
    const msg = e.status === 412 || e.status === 423 ? 'Spreadsheet is busy or was just changed — status columns will be updated on the next check' : `Could not write status columns: ${e.message}`;
    run("UPDATE shops SET sheet_error=? WHERE id=?", msg, shop.id);
    if (e.kind === 'auth') markAccountProblem(shop.sheet_account_id, e.message);
    return { ok: true, created, writeError: msg };
  }
  pollFailures.delete(shop.id);
  resolveAlert(`sheet:${shop.id}`);
  run("UPDATE shops SET sheet_status='ok', sheet_error=NULL, last_polled_at=? WHERE id=?", iso(), shop.id);
  return { ok: true, created, baselined, rows: located.size };
}

function pollFailed(shop, e) {
  const n = (pollFailures.get(shop.id) || 0) + 1;
  pollFailures.set(shop.id, n);
  run("UPDATE shops SET sheet_status='error', sheet_error=?, last_polled_at=? WHERE id=?", e.message, iso(), shop.id);
  if (e.kind === 'auth') markAccountProblem(shop.sheet_account_id, e.message);
  else if (n >= 3) raiseAlert(`sheet:${shop.id}`, `"${shop.name}": spreadsheet can't be read — ${e.message}`, { shop_id: shop.id });
  return { ok: false, error: e.message };
}

const STATUS_TEXT = {
  pending: 'Pending', processing: 'Processing', sent: 'Sent', delivered: 'Delivered', read: 'Read',
  failed: 'Failed', blocked: 'Waiting – action needed', invalid: 'Invalid contact', opted_out: 'Opted out',
};
const SKIP_TEXT = { no_consent: 'Skipped – no consent', consent_invalid: 'Skipped – consent unclear', condition: 'Skipped – rule not met',
  duplicate: 'Skipped – duplicate', no_address: 'Skipped – no address', mode_changed: 'Skipped', invalid: 'Invalid contact' };
export function statusText(job, tz) {
  if (!job) return '';
  if (job.status === 'skipped') return SKIP_TEXT[job.error_kind] || 'Skipped';
  if (job.simulated && ['sent', 'delivered', 'read'].includes(job.status)) return 'SIMULATED – not sent';
  let t = STATUS_TEXT[job.status] || job.status;
  if (job.status === 'pending' && job.next_attempt_at > Date.now() + 60000) t = `${job.attempts ? 'Retrying' : 'Pending'} – ${formatLocal(job.next_attempt_at, tz)}`;
  if (job.mode === 'test' && ['sent', 'delivered', 'read'].includes(job.status)) t += ' (TEST – sent to you)';
  return t;
}

function buildStatusCells(shop, headers, located, dupCells) {
  const tz = shop.settings.schedule.tz;
  const map = shop.column_map;
  const chans = enabledChannels(shop);
  const wanted = STATUS_FIELDS.filter((f) => f.key === 'error_details' || chans.some((c) => f.key.startsWith(c === 'email' ? 'email' : 'whatsapp')));
  const cells = [];
  const colOf = {};
  for (const f of wanted) {
    const h = map[f.key] || f.label;
    let i = headers.indexOf(h);
    if (i < 0) { i = headers.length; headers.push(h); cells.push({ row: shop.header_row || 1, col: i, value: h }); }
    colOf[f.key] = i;
  }
  const identities = [];
  for (const d of all('SELECT row_identity FROM sheet_dirty WHERE shop_id=? AND mode=?', shop.id, shop.mode)) {
    const loc = located.get(d.row_identity);
    if (!loc) continue;
    identities.push(d.row_identity);
    const errors = [];
    for (const ch of chans) {
      const job = one('SELECT * FROM jobs WHERE shop_id=? AND mode=? AND row_identity=? AND channel=? ORDER BY id DESC LIMIT 1', shop.id, shop.mode, d.row_identity, ch);
      if (!job) continue;
      const p = ch === 'email' ? 'email' : 'whatsapp';
      cells.push({ row: loc.rowNumber, col: colOf[`${p}_status`], value: statusText(job, tz) });
      cells.push({ row: loc.rowNumber, col: colOf[`${p}_sent_at`], value: job.sent_at && !job.simulated ? formatLocal(job.sent_at, tz) : '' });
      if (job.last_error && !['sent', 'delivered', 'read'].includes(job.status)) errors.push(`${ch === 'email' ? 'Email' : 'WhatsApp'}: ${job.last_error}`);
      else if (job.simulated && job.status === 'sent') errors.push(`${ch === 'email' ? 'Email' : 'WhatsApp'}: simulated — account not connected/tested`);
    }
    cells.push({ row: loc.rowNumber, col: colOf.error_details, value: errors.join(' | ').slice(0, 1000) });
  }
  // Duplicate rows inside the same sheet: mark once, only if their status cell is still empty.
  for (const d of dupCells) {
    for (const ch of chans) {
      const col = colOf[`${ch === 'email' ? 'email' : 'whatsapp'}_status`];
      if (!d.rec.columns[headers[col]]) cells.push({ row: d.rowNumber, col, value: `Skipped – duplicate of row ${d.first}` });
    }
  }
  cells.__identities = identities;
  return cells;
}

// ---------- sending ----------
function finish(job, fields, logEvent) {
  const sets = Object.keys(fields).map((k) => `${k}=?`).join(', ');
  run(`UPDATE jobs SET ${sets}, updated_at=datetime('now') WHERE id=?`, ...Object.values(fields), job.id);
  const j = { ...job, ...fields };
  dirty(job.shop_id, job.mode, job.row_identity);
  flushSoon.add(job.shop_id);
  if (logEvent) logActivity({ shop_id: job.shop_id, job_id: job.id, channel: job.channel, contact_ref: `${maskRecipient(job.channel, job.recipient) || '—'} (row ${job.row_number})`, ...logEvent });
  return j;
}

function emailDailyCount(accountId) {
  return one(`SELECT COUNT(*) n FROM jobs j JOIN shops s ON s.id=j.shop_id WHERE j.channel='email' AND j.simulated=0
              AND j.status IN ('sent','delivered','read') AND s.gmail_account_id=? AND j.sent_at > ?`, accountId, iso(Date.now() - 86400000)).n;
}

export async function processJob(jobId) {
  const job = one('SELECT * FROM jobs WHERE id=?', jobId);
  if (!job || job.status !== 'pending') return;
  const shop = getShop(job.shop_id);
  if (!shop || shop.status !== 'active' || globalPaused()) return;
  if (shop.mode !== job.mode) return finish(job, { status: 'skipped', error_kind: 'mode_changed', last_error: `Created in ${job.mode} mode; shop is now in ${shop.mode} mode` });
  if (!enabledChannels(shop).includes(job.channel)) return finish(job, { status: 'skipped', error_kind: 'condition', last_error: `${job.channel} is turned off for this shop` });
  if (!inWindow(shop.settings.schedule)) {
    run('UPDATE jobs SET next_attempt_at=? WHERE id=?', nextWindow(shop.settings.schedule), job.id);
    return;
  }
  const rec = JSON.parse(job.payload);
  const ev = evaluate(shop, job.channel, rec);
  if (ev) return finish(job, { status: ev.status, error_kind: ev.kind, last_error: ev.reason }, { event: ev.status, result: ev.kind, detail: ev.reason });

  const tpl = getTemplate(shop.id, job.channel);
  const tplOk = job.channel === 'email' ? tpl?.subject && tpl?.body : tpl?.template_name;
  if (!tplOk) {
    raiseAlert(`template:${shop.id}:${job.channel}`, `"${shop.name}": no ${job.channel === 'email' ? 'email' : 'WhatsApp'} template saved — messages are waiting.`, { shop_id: shop.id });
    return finish(job, { status: 'blocked', error_kind: 'config', last_error: `No ${job.channel} template saved yet` }, { event: 'blocked', result: 'no_template' });
  }
  const accountId = job.channel === 'email' ? shop.gmail_account_id : shop.whatsapp_account_id;
  const ready = accountReady(accountId);
  if (job.mode === 'live' && !ready) {
    raiseAlert(`shopacct:${shop.id}:${job.channel}`, `"${shop.name}": the ${job.channel === 'email' ? 'Gmail' : 'WhatsApp'} account is not connected or not tested — live messages are waiting.`, { shop_id: shop.id });
    return finish(job, { status: 'blocked', error_kind: 'account', last_error: 'Account not connected or needs attention' }, { event: 'blocked', result: 'account' });
  }
  const simulated = !ready;
  let to = job.recipient;
  if (job.mode === 'test') {
    const own = ownerContacts();
    to = job.channel === 'email' ? own.email : own.phone;
    if (!to && !simulated) return finish(job, { status: 'blocked', error_kind: 'config', last_error: `Test mode: add your own ${job.channel === 'email' ? 'email' : 'phone'} under Connections → Your test contact` }, { event: 'blocked', result: 'no_test_recipient' });
  }
  if (job.channel === 'email' && !simulated && emailDailyCount(accountId) >= config.gmailDailyLimit) {
    run('UPDATE jobs SET next_attempt_at=? WHERE id=?', Date.now() + 3600000, job.id);
    raiseAlert(`gmailcap:${accountId}`, `Gmail daily sending limit (${config.gmailDailyLimit}) reached — remaining emails will continue automatically.`, { account_id: accountId });
    return;
  }
  const claimed = run("UPDATE jobs SET status='processing', attempts=attempts+1, updated_at=datetime('now') WHERE id=? AND status='pending'", job.id);
  if (claimed.changes !== 1) return;
  job.attempts += 1;
  try {
    const res = job.channel === 'email'
      ? await deliverEmail(shop, rec, tpl, accountId, to || 'simulated@example.invalid', simulated)
      : await deliverWhatsApp(shop, rec, tpl, accountId, to || '+0000000000', simulated);
    const note = [simulated ? 'SIMULATED — nothing was sent (account not connected/tested yet)' : null, job.mode === 'test' && !simulated ? `TEST MODE — sent to your own ${job.channel === 'email' ? 'email' : 'phone'}, not the contact` : null, res.note].filter(Boolean).join('. ');
    return finish(job, { status: 'sent', simulated: simulated ? 1 : 0, provider_message_id: res.id, sent_at: iso(), last_error: null, error_kind: null },
      { event: simulated ? 'simulated' : 'sent', result: simulated ? 'simulated' : 'ok', detail: note || null, simulated });
  } catch (e) {
    const kind = e.kind || 'permanent';
    if (kind === 'auth' || kind === 'account') {
      markAccountProblem(accountId, e.message);
      return finish(job, { status: 'blocked', error_kind: 'account', last_error: e.message }, { event: 'blocked', result: 'account', detail: e.message });
    }
    if ((kind === 'transient' || kind === 'rate_limit') && job.attempts < MAX_ATTEMPTS) {
      const wait = BACKOFF_MIN[Math.min(job.attempts - 1, BACKOFF_MIN.length - 1)] * 60000;
      return finish(job, { status: 'pending', next_attempt_at: Date.now() + wait, last_error: e.message, error_kind: kind }, { event: 'retry', result: kind, detail: `Attempt ${job.attempts} failed, retrying in ${wait / 60000} min: ${e.message}` });
    }
    return finish(job, { status: 'failed', error_kind: kind, last_error: e.message }, { event: 'failed', result: kind, detail: e.message });
  }
}

export function unsubscribeUrl(shopId, channel, value) {
  return `${config.baseUrl}/u/${sign({ s: shopId, c: channel, v: value })}`;
}

export function composeEmail(shop, rec, tpl, to) {
  const items = selection(shop.id, 'email');
  const { attach, links } = planAttachments(items);
  const unsub = unsubscribeUrl(shop.id, 'email', to);
  const usesLinksVar = /\{\{\s*media_links\s*\}\}/i.test(tpl.body || '');
  const vars = buildVars(shop, rec, { media_links: links.map((l) => `${l.title}: ${l.url}`).join('\n'), unsubscribe_link: unsub });
  const subject = renderTemplate(tpl.subject, vars).replace(/[\r\n]+/g, ' ');
  const text = renderTemplate(tpl.body, vars);
  return { subject, text, attach, links: usesLinksVar ? [] : links, unsub };
}

async function deliverEmail(shop, rec, tpl, accountId, to, simulated) {
  const c = composeEmail(shop, rec, tpl, to);
  const account = simulated ? null : getAccount(accountId);
  const mime = buildMime({ fromName: shop.name, fromEmail: account?.identifier || 'me@example.com', to, subject: c.subject, text: c.text, unsubscribeUrl: c.unsub, shopName: shop.name, attach: c.attach, links: c.links });
  const note = c.links.some((l) => l.auto) ? 'Large file(s) sent as secure download links (over the email size limit)' : null;
  if (simulated) return { id: 'simulated', note };
  return { id: await sendEmail(accountId, account.identifier, mime), note };
}

export function composeWhatsApp(shop, rec, tpl, to) {
  const items = selection(shop.id, 'whatsapp');
  const windowOpen = to ? wa.inServiceWindow(to) : false;
  const mediaSeq = [], links = [], notes = [];
  for (const m of items) {
    const sup = whatsappSupport(m);
    if (m.kind === 'link') links.push(`${m.title}: ${m.url}`);
    else if (sup.ok && windowOpen) mediaSeq.push(m);
    else {
      links.push(`${m.title || m.filename}: ${downloadLink(m)}`);
      if (sup.ok) notes.push(`"${m.filename}" sent as a link (contact hasn't messaged you in the last 24h, so WhatsApp only allows the template)`);
      else notes.push(`"${m.filename}" sent as a link (${sup.reason})`);
    }
  }
  const vars = buildVars(shop, rec, { media_links: links.join(' | ') });
  const clean = (s) => String(s).replace(/\s*[\r\n\t]+\s*/g, ' ').replace(/ {4,}/g, '   ').trim() || '-';
  const bodyParams = (tpl.body_params || []).map((expr) => clean(renderTemplate(expr, vars)));
  const headerTexts = (tpl.header_text_params || []).map((expr) => clean(renderTemplate(expr, vars)));
  const urlButtonParams = (tpl.url_buttons || []).filter((b) => b.expr).map((b) => ({ index: b.index, text: clean(renderTemplate(b.expr, vars)) }));
  if (links.length && !(tpl.body_params || []).some((e) => /media_links/i.test(e))) notes.push(`${links.length} link(s) not included — add {{media_links}} to a template variable to include them`);
  const headerMedia = tpl.header_media_id ? getMedia(shop.id, tpl.header_media_id) : null;
  return { bodyParams, headerTexts, urlButtonParams, headerMedia, mediaSeq, notes };
}

async function deliverWhatsApp(shop, rec, tpl, accountId, to, simulated) {
  const c = composeWhatsApp(shop, rec, tpl, simulated ? null : to);
  if (simulated) return { id: 'simulated', note: c.notes.join('; ') || null };
  const account = getAccount(accountId);
  const id = await wa.sendTemplate(account, to, {
    name: tpl.template_name, language: tpl.language, headerType: tpl.header_format, headerMedia: c.headerMedia,
    headerTexts: c.headerTexts, bodyParams: c.bodyParams, bodyParamNames: tpl.parameter_format === 'NAMED' ? (tpl.body_param_names || []) : [], urlButtonParams: c.urlButtonParams,
  });
  // Extra media in the configured order (only inside the 24h window). A failure here doesn't undo the main message.
  for (const m of c.mediaSeq) {
    try { await wa.sendMedia(account, to, m); }
    catch (e) { c.notes.push(`Extra media "${m.filename}" failed: ${e.message}`); }
  }
  return { id, note: c.notes.join('; ') || null };
}

// ---------- test sends from the UI (to the owner only) ----------
export async function sampleRecord(shop) {
  try {
    const rows = await providerFor(shop).read(shop);
    const headers = (rows[(shop.header_row || 1) - 1] || []).map((h) => String(h || '').trim());
    for (let r = shop.header_row || 1; r < rows.length; r++) {
      const rec = rowToRecord(headers, rows[r] || [], shop.column_map);
      if (rec.fields.name || rec.fields.email) return rec;
    }
  } catch { /* fall through */ }
  return { fields: { name: 'Sample Customer', email: 'customer@example.com', phone: '+971500000000', whatsapp: '', company: '', consent: 'Yes' }, columns: {} };
}

export async function testSend(shopId, channel) {
  const shop = getShop(shopId);
  const own = ownerContacts();
  const to = channel === 'email' ? own.email : own.phone;
  if (!to) throw new Error(`Add your own ${channel === 'email' ? 'email address' : 'WhatsApp number'} first (Connections → Your test contact).`);
  const tpl = getTemplate(shop.id, channel);
  if (channel === 'email' && !(tpl?.subject && tpl?.body)) throw new Error('Save an email subject and message first.');
  if (channel === 'whatsapp' && !tpl?.template_name) throw new Error('Choose and save an approved WhatsApp template first.');
  const accountId = channel === 'email' ? shop.gmail_account_id : shop.whatsapp_account_id;
  const acct = accountId ? getAccount(accountId) : null;
  const rec = await sampleRecord(shop);
  if (!acct || acct.status === 'disconnected') {
    logActivity({ shop_id: shop.id, channel, contact_ref: 'you (test)', event: 'simulated', result: 'test', detail: 'Test send SIMULATED — no account selected for this shop', simulated: 1 });
    return { simulated: true, message: `SIMULATED: no ${channel === 'email' ? 'Gmail' : 'WhatsApp'} account is selected for this shop, so nothing was sent.` };
  }
  const res = channel === 'email' ? await deliverEmail(shop, rec, tpl, accountId, to, false) : await deliverWhatsApp(shop, rec, tpl, accountId, to, false);
  run("UPDATE accounts SET tested_at=datetime('now'), status='connected', last_error=NULL WHERE id=?", accountId);
  const st = shop.settings; st.tested = { ...(st.tested || {}), [channel]: iso() };
  run('UPDATE shops SET settings=? WHERE id=?', JSON.stringify(st), shop.id);
  logActivity({ shop_id: shop.id, channel, contact_ref: `${maskRecipient(channel, to)} (you)`, event: 'test_sent', result: 'ok', detail: res.note });
  return { simulated: false, message: `Real test ${channel === 'email' ? 'email' : 'WhatsApp message'} sent to ${to}. Check that it arrived.${res.note ? ' Note: ' + res.note : ''}` };
}

// Can this shop go live? Returns a list of blocking problems (empty = ready).
export function liveReadiness(shop) {
  const p = [];
  if (!shop.sheet_provider || shop.sheet_provider === 'demo') p.push('Connect a real Google Sheet or OneDrive Excel file (the demo sheet is for testing only).');
  if (!shop.sheet_tab) p.push('Choose the sheet tab.');
  if (shop.sheet_status === 'error') p.push('Fix the spreadsheet error first.');
  for (const ch of enabledChannels(shop)) {
    const name = ch === 'email' ? 'Gmail' : 'WhatsApp';
    const id = ch === 'email' ? shop.gmail_account_id : shop.whatsapp_account_id;
    if (!id) p.push(`Select a ${name} account.`);
    else if (!accountReady(id)) p.push(`The ${name} account is not connected or not tested.`);
    if (!getTemplate(shop.id, ch)) p.push(`Save the ${name === 'Gmail' ? 'email' : 'WhatsApp'} template.`);
    if (!shop.settings.tested?.[ch]) p.push(`Send a successful real test ${ch === 'email' ? 'email' : 'WhatsApp message'} to yourself (Message Templates page).`);
  }
  return p;
}

// ---------- WhatsApp webhooks ----------
const STOP_RE = /^\s*(stop|unsubscribe|stop all|إيقاف|ايقاف|الغاء|إلغاء)\b/i;
export function handleWebhook(body) {
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      for (const s of v.statuses || []) {
        const job = one('SELECT * FROM jobs WHERE provider_message_id=?', s.id);
        if (!job) continue;
        if (s.status === 'delivered' && job.status === 'sent') finish(job, { status: 'delivered', delivered_at: iso(Number(s.timestamp) * 1000) }, { event: 'delivered', result: 'ok' });
        else if (s.status === 'read' && ['sent', 'delivered'].includes(job.status)) finish(job, { status: 'read', delivered_at: job.delivered_at || iso(Number(s.timestamp) * 1000) }, { event: 'read', result: 'ok' });
        else if (s.status === 'failed') {
          const err = s.errors?.[0] || {};
          const help = wa.WA_ERROR_HELP[err.code];
          const msg = `WhatsApp could not deliver: ${err.title || err.message || 'failed'}${err.code ? ` (code ${err.code})` : ''}${help ? ' — ' + help : ''}`;
          finish(job, { status: 'failed', error_kind: 'permanent', last_error: msg }, { event: 'failed', result: 'provider', detail: msg });
        }
      }
      for (const m of v.messages || []) {
        const phone = '+' + String(m.from).replace(/\D/g, '');
        run('INSERT INTO wa_inbound (phone, last_inbound_at) VALUES (?,?) ON CONFLICT(phone) DO UPDATE SET last_inbound_at=excluded.last_inbound_at', phone, Date.now());
        const text = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || '';
        if (STOP_RE.test(text)) {
          const shops = all(`SELECT DISTINCT shop_id FROM jobs WHERE channel='whatsapp' AND recipient=? AND status IN ('sent','delivered','read') AND sent_at > ?`, phone, iso(Date.now() - 60 * 86400000));
          const global = /all/i.test(text) || shops.length === 0;
          if (global) addSuppression('global', 'whatsapp', phone, `Replied "${text.slice(0, 40)}" on WhatsApp`);
          else for (const s of shops) addSuppression(String(s.shop_id), 'whatsapp', phone, `Replied "${text.slice(0, 40)}" on WhatsApp`);
          logActivity({ shop_id: global ? null : shops[0]?.shop_id, channel: 'whatsapp', contact_ref: maskRecipient('whatsapp', phone), event: 'opted_out', result: global ? 'global' : 'shop', detail: 'Contact replied STOP' });
        }
      }
    }
  }
}

export function addSuppression(scope, channel, value, reason) {
  const v = channel === 'email' ? normalizeEmail(value) : channel === 'whatsapp' ? normalizePhone(value, '971') : (normalizeEmail(value) || normalizePhone(value, '971'));
  if (!v) throw new Error('Enter a valid email address or phone number');
  run('INSERT OR IGNORE INTO suppression (scope, channel, value, reason) VALUES (?,?,?,?)', String(scope), channel, v, reason || null);
  return v;
}

// ---------- notifications & health ----------
export async function sendNotifications() {
  const pending = all("SELECT * FROM alerts WHERE resolved_at IS NULL AND notified_at IS NULL AND created_at <= datetime('now','-1 minute')");
  if (!pending.length) return;
  const own = ownerContacts();
  const acct = one("SELECT id, identifier FROM accounts WHERE provider='google' AND status='connected' AND tested_at IS NOT NULL ORDER BY id LIMIT 1");
  for (const a of pending) {
    run("UPDATE alerts SET notified_at=datetime('now') WHERE id=?", a.id);
    if (!own.email || !acct) continue;
    try {
      const mime = buildMime({ fromName: 'SheetSender alerts', fromEmail: acct.identifier, to: own.email, subject: 'Action needed: ' + a.message.slice(0, 80),
        text: `${a.message}\n\nOpen your dashboard: ${config.baseUrl}`, unsubscribeUrl: config.baseUrl, shopName: 'SheetSender', attach: [], links: [] });
      await sendEmail(acct.id, acct.identifier, mime);
    } catch { /* the dashboard banner still shows the alert */ }
  }
}

export async function healthCheck() {
  for (const a of all("SELECT id, provider FROM accounts WHERE status != 'disconnected' AND tested_at IS NOT NULL")) {
    try {
      if (a.provider === 'whatsapp') await testAccount(a.id);
      else { await getAccessToken(a.id); run("UPDATE accounts SET checked_at=datetime('now') WHERE id=?", a.id); }
    } catch { /* marked inside */ }
  }
}

export function retryJobs(shopId, jobIds = null) {
  // Only failed or blocked jobs are retried — a job that was already sent is never re-sent.
  const rows = jobIds
    ? all(`SELECT id, row_identity, mode FROM jobs WHERE shop_id=? AND status IN ('failed','blocked') AND id IN (SELECT value FROM json_each(?))`, shopId, JSON.stringify(jobIds))
    : all(`SELECT id, row_identity, mode FROM jobs WHERE shop_id=? AND status IN ('failed','blocked')`, shopId);
  for (const r of rows) {
    run("UPDATE jobs SET status='pending', attempts=0, next_attempt_at=?, error_kind=NULL, updated_at=datetime('now') WHERE id=?", Date.now(), r.id);
    dirty(shopId, r.mode, r.row_identity);
  }
  if (rows.length) logActivity({ shop_id: shopId, event: 'retry', result: 'manual', detail: `${rows.length} failed message(s) queued again` });
  return rows.length;
}
