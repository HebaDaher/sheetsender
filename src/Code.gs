/**
 * Shop Follow-ups — a private email + WhatsApp follow-up tool for several shops.
 *
 * Stack: Google Apps Script (standalone project), HTML Service web app, one Google Sheet as the database,
 * Gmail API (through Google OAuth 2.0) to send email from each shop's own connected Gmail account.
 *
 * HOW ACCESS WORKS
 *  - The web app runs as the person who opens it ("User accessing the web app").
 *    Only Editors of the database Google Sheet can use it; everyone else gets a clear error.
 *  - The script is a STANDALONE project owned by the owner. Sheet editors (e.g. Dad) cannot see or change its code.
 *  - Emails are sent by a time-based trigger that belongs to the OWNER. Each shop's email goes out through the
 *    Gmail account connected for that shop (OAuth, scope gmail.send only).
 *  - OAuth refresh tokens and the OAuth client secret live in the OWNER's private UserProperties: only code running
 *    as the owner can read them. They are never sent to the web page and never written to the Sheet.
 *
 * Files: Code.gs (data + web app API), Senders.gs (Gmail OAuth + sending), Sending.gs (queue + trigger),
 *        Index.html, Styles.html, App.html, SheetJS.html
 */

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const APP_NAME = 'Shop Follow-ups';
const DEFAULT_DELAY_MINUTES = 5;
const ALLOWED_DELAYS = [1, 2, 3, 5, 10, 15, 30, 60];
const MAX_SEND_ATTEMPTS = 3;
const DEFAULT_COUNTRY_CODE = '971';
const PLACEHOLDERS = ['first_name', 'full_name', 'shop_name', 'sender_name', 'email', 'phone'];

const TABS = {
  SHOPS: 'Shops',
  CONTACTS: 'Contacts',
  TEMPLATES: 'Templates',
  CAMPAIGNS: 'Campaigns',
  LOG: 'Send Log'
};

const HEADERS = {
  Shops: ['shop_id', 'shop_name', 'sender_email', 'sender_name', 'reply_to', 'country_code', 'active', 'notes'],
  Contacts: ['contact_id', 'shop_id', 'full_name', 'first_name', 'email', 'phone',
    'consent_status', 'consent_source', 'consent_date', 'opted_out', 'opt_out_date', 'opt_out_reason',
    'created_at', 'updated_at', 'source_file'],
  Templates: ['template_id', 'shop_id', 'template_name', 'channel', 'subject', 'body', 'active', 'updated_at'],
  Campaigns: ['campaign_id', 'shop_id', 'campaign_name', 'template_id', 'sender_email', 'delay_minutes',
    'skip_previous_recipients', 'status', 'status_reason', 'created_by', 'created_at', 'started_at',
    'next_send_at', 'finished_at', 'total', 'sent', 'skipped', 'failed', 'pending'],
  'Send Log': ['log_id', 'campaign_id', 'shop_id', 'contact_id', 'contact_name', 'email', 'phone', 'template_id',
    'channel', 'sender_email', 'status', 'reason', 'queued_at', 'sent_at', 'attempts', 'done_by']
};

/** Script properties: shared, NON-secret settings and status only. */
const PROP = {
  SHEET_ID: 'SHEET_ID',
  OWNER_EMAIL: 'OWNER_EMAIL',
  ACCOUNTS: 'GMAIL_ACCOUNTS',          // {email: {status, connected_at, last_ok_at, last_error, ...}} — no tokens
  OAUTH_CLIENT_ID: 'OAUTH_CLIENT_ID',  // public identifier, not a secret
  NEXT_DUE_AT: 'NEXT_DUE_AT',
  LAST_ENGINE_RUN: 'LAST_ENGINE_RUN'
};

const YES_WORDS = ['yes', 'y', 'true', '1', 'granted', 'consented', 'consent', 'agreed', 'agree', 'opted in',
  'opted-in', 'opt in', 'opt-in', 'subscribed', 'نعم', 'موافق', 'موافقة'];
const NO_WORDS = ['no', 'n', 'false', '0', 'declined', 'refused', 'denied', 'not agreed', 'لا', 'غير موافق'];
const OPTOUT_WORDS = ['yes', 'y', 'true', '1', 'opted out', 'opted-out', 'opt out', 'opt-out', 'unsubscribed',
  'unsubscribe', 'stop', 'نعم'];

/* ------------------------------------------------------------------ */
/* Web app entry                                                       */
/* ------------------------------------------------------------------ */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.state && (p.code || p.error)) return oauthCallbackPage_(p); // Google sends people back here after "Allow"
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Inserts another project file's raw content into the page (not evaluated as a template). */
function include(name) {
  if (['Styles', 'App', 'SheetJS'].indexOf(name) === -1) throw new Error('Unknown file');
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* ------------------------------------------------------------------ */
/* Owner setup                                                          */
/* ------------------------------------------------------------------ */

/**
 * Run ONCE by the owner from the Apps Script editor (select "setup" and press Run).
 * Creates the database Google Sheet (or repairs it), installs the sending trigger. Safe to run again; never deletes data.
 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  const me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  const existingOwner = String(props.getProperty(PROP.OWNER_EMAIL) || '').toLowerCase();
  if (!me) throw new Error('Could not read your Google account email. Please try again.');
  if (existingOwner && existingOwner !== me) {
    throw new Error('Setup was already done by ' + existingOwner + '. Only that account can run setup again.');
  }

  let ss = null;
  const sheetId = props.getProperty(PROP.SHEET_ID);
  if (sheetId) {
    ss = SpreadsheetApp.openById(sheetId);
  } else {
    ss = SpreadsheetApp.create(APP_NAME + ' — Database');
    props.setProperty(PROP.SHEET_ID, ss.getId());
  }
  props.setProperty(PROP.OWNER_EMAIL, me);
  ss.setSpreadsheetTimeZone('Asia/Dubai');

  Object.keys(HEADERS).forEach(function (tab) { ensureTab_(ss, tab); });
  ['Sheet1', 'Feuille 1', 'ورقة1'].forEach(function (name) {
    const s = ss.getSheetByName(name);
    if (s && ss.getSheets().length > 1 && s.getLastRow() === 0) ss.deleteSheet(s);
  });
  seedExamples_(ss);
  installTrigger_();

  const msg = 'Setup finished.\nOwner: ' + me + '\nDatabase Sheet: ' + ss.getUrl() +
    '\nNext: deploy the web app, then open it and go to Settings to connect Gmail accounts.';
  Logger.log(msg);
  return msg;
}

/** (Re)installs the every-minute sending trigger, owned by whoever runs it — must be the owner. */
function installTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processQueue') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processQueue').timeBased().everyMinutes(1).create();
}

function ensureTab_(ss, tab) {
  const headers = HEADERS[tab];
  let sheet = ss.getSheetByName(tab);
  if (!sheet) sheet = ss.insertSheet(tab);
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const current = sheet.getLastRow() > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); })
    : [];
  if (current.filter(String).length === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    const missing = headers.filter(function (h) { return current.indexOf(h) === -1; });
    if (missing.length) {
      const start = current.filter(String).length + 1;
      sheet.getRange(1, start, 1, missing.length).setValues([missing]);
    }
  }
  const width = Math.max(sheet.getLastColumn(), headers.length);
  sheet.getRange(1, 1, sheet.getMaxRows(), width).setNumberFormat('@'); // plain text: keeps phone numbers & dates exactly
  sheet.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#e8eef7');
  sheet.setFrozenRows(1);
  return sheet;
}

function seedExamples_(ss) {
  const shops = readTable_(ss, TABS.SHOPS);
  if (shops.rows.length > 0) return;
  const now = nowIso_();
  appendRows_(shops, [{
    shop_id: 'SHOP1', shop_name: 'Example Shop', sender_email: '', sender_name: 'Example Shop',
    reply_to: '', country_code: DEFAULT_COUNTRY_CODE, active: 'yes',
    notes: 'Example row. Rename it or add one row per shop. Choose the sending Gmail in the app: Settings > Shops.'
  }]);
  const templates = readTable_(ss, TABS.TEMPLATES);
  appendRows_(templates, [
    {
      template_id: 'T1', shop_id: 'SHOP1', template_name: 'Follow-up email', channel: 'email',
      subject: 'Still interested in {shop_name}?',
      body: 'Hi {first_name},\n\nThank you for your interest in {shop_name}. The shop is still available and ' +
        'I would be happy to share the details or arrange a visit.\n\nJust reply to this email and I will get back to you.\n\n' +
        'Best regards,\n{sender_name}\n\nIf you would rather not receive these emails, reply STOP and we will remove you.',
      active: 'yes', updated_at: now
    },
    {
      template_id: 'T2', shop_id: 'SHOP1', template_name: 'WhatsApp follow-up', channel: 'whatsapp', subject: '',
      body: 'Hello {first_name}, this is {sender_name} about {shop_name}. Are you still interested? ' +
        'I can send you the details. (Reply STOP if you prefer no more messages.)',
      active: 'yes', updated_at: now
    }
  ]);
}

/* ------------------------------------------------------------------ */
/* Access control                                                      */
/* ------------------------------------------------------------------ */

/** Opens the database and checks the current person may use the app. Returns {ss, email}. */
function requireUser_() {
  const props = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty(PROP.SHEET_ID);
  if (!sheetId) {
    throw new Error('The app is not set up yet. The owner must run "setup" once in the Apps Script editor.');
  }
  const email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email) throw new Error('Please sign in to your Google account and reload this page.');
  let ss;
  try {
    ss = SpreadsheetApp.openById(sheetId);
  } catch (e) {
    throw new Error('Your account (' + email + ') does not have access to this app. ' +
      'Ask the owner to share the app\'s Google Sheet with you as an Editor, then reload.');
  }
  const owner = String(props.getProperty(PROP.OWNER_EMAIL) || '').toLowerCase();
  const editors = ss.getEditors().map(function (u) { return String(u.getEmail()).toLowerCase(); });
  if (email !== owner && editors.indexOf(email) === -1) {
    throw new Error('Your account (' + email + ') can view the Sheet but is not an Editor. ' +
      'Ask the owner to give you Editor access.');
  }
  return { ss: ss, email: email, isOwner: email === owner };
}

/** Same as requireUser_, but only the owner may continue (Settings, Gmail connections). */
function requireOwner_() {
  const ctx = requireUser_();
  if (!ctx.isOwner) throw new Error('Only the app owner can change settings.');
  return ctx;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('The app is busy (another action is running). Please try again in a few seconds.');
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ------------------------------------------------------------------ */
/* Sheet helpers                                                        */
/* ------------------------------------------------------------------ */

function readTable_(ss, tab) {
  const sheet = ss.getSheetByName(tab);
  if (!sheet) throw new Error('The "' + tab + '" tab is missing from the Sheet. The owner should run setup again in the Apps Script editor.');
  const values = sheet.getLastRow() > 0 ? sheet.getDataRange().getValues() : [[]];
  const headers = (values[0] || []).map(function (h) { return String(h).trim(); });
  HEADERS[tab].forEach(function (h) {
    if (headers.indexOf(h) === -1) {
      throw new Error('Column "' + h + '" is missing in the "' + tab + '" tab. The owner should run setup again in the Apps Script editor.');
    }
  });
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (r.every(function (v) { return v === '' || v === null; })) continue;
    const obj = { _row: i + 1 };
    headers.forEach(function (h, c) { if (h) obj[h] = str_(r[c]); });
    rows.push(obj);
  }
  return { sheet: sheet, tab: tab, headers: headers, rows: rows };
}

function toArray_(table, obj) {
  return table.headers.map(function (h) { return h ? safeCell_(obj[h]) : ''; });
}

function updateRow_(table, obj) {
  table.sheet.getRange(obj._row, 1, 1, table.headers.length).setValues([toArray_(table, obj)]);
}

function appendRows_(table, objs) {
  if (!objs.length) return;
  const sheet = table.sheet;
  const start = sheet.getLastRow() + 1;
  const needed = start + objs.length - 1 - sheet.getMaxRows();
  if (needed > 0) sheet.insertRowsAfter(sheet.getMaxRows(), needed);
  const range = sheet.getRange(start, 1, objs.length, table.headers.length);
  range.setNumberFormat('@');
  range.setValues(objs.map(function (o) { return toArray_(table, o); }));
  objs.forEach(function (o, i) { o._row = start + i; table.rows.push(o); });
}

/** Rewrites many existing rows in one call (rows must be sorted by _row within one block for speed). */
function updateRows_(table, objs) {
  objs.forEach(function (o) { updateRow_(table, o); });
}

function str_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v).trim();
}

/** Stops cell text from being read as a formula (e.g. a name that starts with "="). */
function safeCell_(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function nowIso_() { return new Date().toISOString(); }

function newId_(prefix) {
  return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase();
}

/* ------------------------------------------------------------------ */
/* Rules: consent, emails, phones, templates                            */
/* ------------------------------------------------------------------ */

function norm_(v) { return String(v || '').trim().toLowerCase(); }

function isYes_(v) { return YES_WORDS.indexOf(norm_(v)) !== -1; }
function isNo_(v) { return NO_WORDS.indexOf(norm_(v)) !== -1; }
function isOptedOut_(v) { return OPTOUT_WORDS.indexOf(norm_(v)) !== -1; }

function isValidEmail_(email) {
  return /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[a-z]{2,}$/i.test(String(email || '').trim());
}

/**
 * Turns local numbers into international digits for WhatsApp (no "+").
 * 0501234567 -> 971501234567, +971 50 123 4567 -> 971501234567, 00971... -> 971...
 */
function normalizePhone_(raw, countryCode) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const cc = String(countryCode || DEFAULT_COUNTRY_CODE).replace(/\D/g, '') || DEFAULT_COUNTRY_CODE;
  let digits = s.replace(/\D/g, '');
  if (!digits) return '';
  if (s.charAt(0) === '+') {
    // already international
  } else if (digits.indexOf('00') === 0) {
    digits = digits.slice(2);
  } else if (digits.charAt(0) === '0') {
    digits = cc + digits.slice(1);
  } else if (digits.length <= 9) {
    digits = cc + digits;
  }
  return digits;
}

function isValidPhone_(digits) { return /^\d{8,15}$/.test(String(digits || '')); }

/**
 * Can we message this contact on this channel? Returns {ok:boolean, reason:string}.
 * Anyone opted out, or without a clear "yes" consent, is skipped.
 */
function eligibility_(contact, channel) {
  if (isOptedOut_(contact.opted_out)) return { ok: false, reason: 'Opted out' };
  const consent = contact.consent_status;
  if (!String(consent || '').trim()) return { ok: false, reason: 'No consent recorded' };
  if (isNo_(consent)) return { ok: false, reason: 'Did not give consent' };
  if (!isYes_(consent)) return { ok: false, reason: 'Consent is unclear ("' + consent + '")' };
  if (channel === 'whatsapp') {
    if (!contact.phone) return { ok: false, reason: 'No phone number' };
    if (!isValidPhone_(contact.phone)) return { ok: false, reason: 'Phone number looks invalid' };
  } else {
    if (!contact.email) return { ok: false, reason: 'No email address' };
    if (!isValidEmail_(contact.email)) return { ok: false, reason: 'Email address looks invalid' };
  }
  return { ok: true, reason: '' };
}

function firstNameOf_(contact) {
  if (contact.first_name) return contact.first_name;
  return String(contact.full_name || '').trim().split(/\s+/)[0] || '';
}

function templateFields_(contact, shop) {
  return {
    first_name: firstNameOf_(contact) || 'there',
    full_name: contact.full_name || firstNameOf_(contact) || 'there',
    shop_name: shop.shop_name || '',
    sender_name: shop.sender_name || shop.shop_name || '',
    email: contact.email || '',
    phone: contact.phone || ''
  };
}

/** Replaces {field} with values. Field names are case-insensitive; unknown fields are left as they are. */
function renderText_(text, fields) {
  return String(text || '').replace(/\{\s*([a-zA-Z_]+)\s*\}/g, function (m, key) {
    const k = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(fields, k) ? fields[k] : m;
  });
}

function unknownPlaceholders_(text) {
  const found = [];
  String(text || '').replace(/\{\s*([a-zA-Z_]+)\s*\}/g, function (m, key) {
    if (PLACEHOLDERS.indexOf(key.toLowerCase()) === -1 && found.indexOf(m) === -1) found.push(m);
    return m;
  });
  return found;
}

function escapeHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textToHtml_(text) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222">' +
    escapeHtml_(text).replace(/\r?\n/g, '<br>') + '</div>';
}

/* ------------------------------------------------------------------ */
/* Sender addresses                                                     */
/* ------------------------------------------------------------------ */

/** Is this shop's Gmail account connected and usable? (Reads public status only — no tokens.) */
function senderCheck_(shop) {
  const sender = norm_(shop.sender_email);
  if (!sender) {
    return { ok: false, reason: 'No Gmail account is chosen for this shop. The owner must open Settings > Shops and choose one.' };
  }
  const acc = accountStatus_()[sender];
  if (acc && acc.status === 'connected') return { ok: true, reason: '' };
  if (acc && acc.status === 'needs_reconnect') {
    return { ok: false, reason: 'The Gmail account ' + sender + ' needs to be reconnected (' + (acc.last_error || 'its permission expired or was removed') +
      '). The owner must open Settings > Gmail accounts and click Reconnect, then sign in as ' + sender + ' and click Allow.' };
  }
  if (acc && acc.status === 'disconnected') {
    return { ok: false, reason: 'The Gmail account ' + sender + ' was disconnected. The owner must open Settings > Gmail accounts, ' +
      'click Reconnect next to it, sign in as ' + sender + ' and click Allow.' };
  }
  return { ok: false, reason: 'The Gmail account ' + sender + ' is not connected. The owner must open Settings > Gmail accounts, ' +
    'click Connect a Gmail account, sign in as ' + sender + ' and click Allow.' };
}

/* ------------------------------------------------------------------ */
/* Lookups                                                              */
/* ------------------------------------------------------------------ */

function findShop_(ss, shopId) {
  const shop = readTable_(ss, TABS.SHOPS).rows.filter(function (s) { return s.shop_id === shopId; })[0];
  if (!shop) throw new Error('Shop "' + shopId + '" was not found. Reload the page.');
  return shop;
}

function isActive_(v) { return v === '' || !isNo_(v) && norm_(v) !== 'inactive'; }

function publicShop_(shop) {
  const check = senderCheck_(shop);
  return {
    shop_id: shop.shop_id, shop_name: shop.shop_name, sender_email: shop.sender_email,
    sender_name: shop.sender_name, reply_to: shop.reply_to, country_code: shop.country_code || DEFAULT_COUNTRY_CODE,
    senderOk: check.ok, senderProblem: check.reason
  };
}

function stripRow_(o) {
  const out = {};
  Object.keys(o).forEach(function (k) { if (k !== '_row') out[k] = o[k]; });
  return out;
}

/* ------------------------------------------------------------------ */
/* API used by the web page                                             */
/* ------------------------------------------------------------------ */

function getBootstrap() {
  const ctx = requireUser_();
  const props = PropertiesService.getScriptProperties();
  const shops = readTable_(ctx.ss, TABS.SHOPS).rows
    .filter(function (s) { return s.shop_id && isActive_(s.active); })
    .map(publicShop_);
  const ids = {};
  const problems = [];
  readTable_(ctx.ss, TABS.SHOPS).rows.forEach(function (s) {
    if (!s.shop_id) problems.push('A row in the Shops tab has no shop_id.');
    else if (ids[s.shop_id]) problems.push('shop_id "' + s.shop_id + '" is used twice in the Shops tab.');
    ids[s.shop_id] = true;
  });
  let settingsNeeded = '';
  if (ctx.isOwner) {
    const connected = Object.keys(accountStatus_()).filter(function (k) { return accountStatus_()[k].status === 'connected'; });
    if (!props.getProperty(PROP.OAUTH_CLIENT_ID)) settingsNeeded = 'save the Google sign-in Client ID and secret, then connect the shops\' Gmail accounts.';
    else if (!connected.length) settingsNeeded = 'connect at least one Gmail account.';
    else if (shops.some(function (s) { return !s.senderOk; })) settingsNeeded = 'some shops have no connected Gmail account chosen.';
  }
  return {
    user: ctx.email,
    isOwner: ctx.isOwner,
    settingsNeeded: settingsNeeded,
    owner: props.getProperty(PROP.OWNER_EMAIL),
    shops: shops,
    setupProblems: problems,
    engine: engineStatus_(),
    defaultDelay: DEFAULT_DELAY_MINUTES,
    allowedDelays: ALLOWED_DELAYS,
    placeholders: PLACEHOLDERS,
    sheetUrl: ctx.ss.getUrl()
  };
}

function engineStatus_() {
  const props = PropertiesService.getScriptProperties();
  const last = props.getProperty(PROP.LAST_ENGINE_RUN);
  const minutes = last ? Math.round((Date.now() - new Date(last).getTime()) / 60000) : null;
  return { lastRun: last || '', minutesAgo: minutes, healthy: minutes !== null && minutes <= 10 };
}

function getShopData(shopId) {
  const ctx = requireUser_();
  const shop = findShop_(ctx.ss, shopId);
  const templates = readTable_(ctx.ss, TABS.TEMPLATES).rows
    .filter(function (t) { return t.shop_id === shopId; })
    .map(stripRow_);
  const logRows = readTable_(ctx.ss, TABS.LOG).rows.filter(function (l) { return l.shop_id === shopId; });
  const lastEmail = {}, lastWa = {};
  logRows.forEach(function (l) {
    if (l.status === 'sent' && l.channel === 'email') lastEmail[l.contact_id] = l.sent_at;
    if (l.channel === 'whatsapp') lastWa[l.contact_id] = l.sent_at;
  });
  const contacts = readTable_(ctx.ss, TABS.CONTACTS).rows
    .filter(function (c) { return c.shop_id === shopId; })
    .map(function (c) {
      const out = stripRow_(c);
      out.emailCheck = eligibility_(c, 'email');
      out.waCheck = eligibility_(c, 'whatsapp');
      out.lastEmailAt = lastEmail[c.contact_id] || '';
      out.lastWhatsAppAt = lastWa[c.contact_id] || '';
      return out;
    });
  const campaigns = readTable_(ctx.ss, TABS.CAMPAIGNS).rows
    .filter(function (c) { return c.shop_id === shopId; })
    .map(stripRow_)
    .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
  return { shop: publicShop_(shop), templates: templates, contacts: contacts, campaigns: campaigns, engine: engineStatus_() };
}

/**
 * Imports or updates contacts for one shop.
 * rows: [{full_name, first_name, email, phone, consent_status, consent_source, consent_date, opted_out}]
 * Matching: same shop + same email, otherwise same shop + same phone.
 * An existing opt-out is never removed by an import.
 */
function importContacts(shopId, rows, meta) {
  const ctx = requireUser_();
  if (!Array.isArray(rows)) throw new Error('No rows were received.');
  if (rows.length > 2000) throw new Error('Too many rows in one batch.');
  meta = meta || {};
  return withLock_(function () {
    const shop = findShop_(ctx.ss, shopId);
    const table = readTable_(ctx.ss, TABS.CONTACTS);
    const byEmail = {}, byPhone = {};
    table.rows.forEach(function (c) {
      if (c.shop_id !== shopId) return;
      if (c.email) byEmail[norm_(c.email)] = c;
      if (c.phone) byPhone[c.phone] = c;
    });
    const now = nowIso_();
    const result = { added: 0, updated: 0, unchanged: 0, rejected: 0, problems: [] };
    const toAdd = [], toUpdate = [];

    rows.forEach(function (raw, i) {
      const rowNo = (meta.firstRowNumber || 2) + i;
      const email = norm_(raw.email);
      const phone = normalizePhone_(raw.phone, shop.country_code);
      const c = {
        full_name: String(raw.full_name || '').trim(),
        first_name: String(raw.first_name || '').trim(),
        email: email,
        phone: phone,
        consent_status: String(raw.consent_status || '').trim(),
        consent_source: String(raw.consent_source || '').trim(),
        consent_date: String(raw.consent_date || '').trim(),
        opted_out: isOptedOut_(raw.opted_out) ? 'yes' : ''
      };
      if (!c.full_name && !c.first_name && !email && !phone) return; // blank line
      if (!email && !phone) {
        result.rejected++;
        if (result.problems.length < 50) result.problems.push('Row ' + rowNo + ': no email and no phone number.');
        return;
      }
      if (email && !isValidEmail_(email) && result.problems.length < 50) {
        result.problems.push('Row ' + rowNo + ': email "' + raw.email + '" looks invalid (saved, but it will be skipped).');
      }
      if (phone && !isValidPhone_(phone) && result.problems.length < 50) {
        result.problems.push('Row ' + rowNo + ': phone "' + raw.phone + '" looks invalid (saved, but WhatsApp will skip it).');
      }
      const existing = (email && byEmail[email]) || (phone && byPhone[phone]);
      if (existing) {
        let changed = false;
        ['full_name', 'first_name', 'email', 'phone', 'consent_status', 'consent_source', 'consent_date'].forEach(function (k) {
          if (c[k] && c[k] !== existing[k]) { existing[k] = c[k]; changed = true; }
        });
        if (c.opted_out && !isOptedOut_(existing.opted_out)) {
          existing.opted_out = 'yes'; existing.opt_out_date = now; existing.opt_out_reason = 'Marked in imported file';
          changed = true;
        }
        if (!existing._row) {
          // Same person appears twice in this file: merged into the row being added.
          if (result.problems.length < 50) result.problems.push('Row ' + rowNo + ': same person as an earlier row in this file (merged into one contact).');
        } else if (changed) {
          existing.updated_at = now;
          existing.source_file = meta.fileName || existing.source_file;
          if (toUpdate.indexOf(existing) === -1) toUpdate.push(existing);
          result.updated++;
        } else {
          result.unchanged++;
        }
        if (existing.email) byEmail[existing.email] = existing;
        if (existing.phone) byPhone[existing.phone] = existing;
        return;
      }
      const created = {
        contact_id: newId_('C'), shop_id: shopId,
        full_name: c.full_name, first_name: c.first_name, email: email, phone: phone,
        consent_status: c.consent_status, consent_source: c.consent_source, consent_date: c.consent_date,
        opted_out: c.opted_out, opt_out_date: c.opted_out ? now : '', opt_out_reason: c.opted_out ? 'Marked in imported file' : '',
        created_at: now, updated_at: now, source_file: meta.fileName || ''
      };
      toAdd.push(created);
      if (email) byEmail[email] = created;
      if (phone) byPhone[phone] = created;
      result.added++;
    });

    // Updates: rewrite the whole data block once (fast), then append new rows.
    if (toUpdate.length) {
      const data = table.rows.map(function (o) { return toArray_(table, o); });
      const first = table.rows.length ? table.rows[0]._row : 2;
      const contiguous = table.rows.every(function (o, i) { return o._row === first + i; });
      if (contiguous && data.length) {
        table.sheet.getRange(first, 1, data.length, table.headers.length).setValues(data);
      } else {
        updateRows_(table, toUpdate);
      }
    }
    appendRows_(table, toAdd);
    return result;
  });
}

function markOptedOut(contactId, reason) {
  const ctx = requireUser_();
  return withLock_(function () {
    const table = readTable_(ctx.ss, TABS.CONTACTS);
    const c = table.rows.filter(function (r) { return r.contact_id === contactId; })[0];
    if (!c) throw new Error('Contact not found. Reload the page.');
    c.opted_out = 'yes';
    c.opt_out_date = nowIso_();
    c.opt_out_reason = String(reason || 'Marked in app by ' + ctx.email).slice(0, 300);
    c.updated_at = c.opt_out_date;
    updateRow_(table, c);
    return stripRow_(c);
  });
}

function saveTemplate(t) {
  const ctx = requireUser_();
  t = t || {};
  const channel = norm_(t.channel) === 'whatsapp' ? 'whatsapp' : 'email';
  const name = String(t.template_name || '').trim();
  const body = String(t.body || '').trim();
  const subject = String(t.subject || '').trim();
  if (!name) throw new Error('Give the template a name.');
  if (!body) throw new Error('The message text is empty.');
  if (channel === 'email' && !subject) throw new Error('Email templates need a subject.');
  const unknown = unknownPlaceholders_(subject + ' ' + body);
  if (unknown.length) {
    throw new Error('These fields are not known: ' + unknown.join(', ') + '. You can use: {' + PLACEHOLDERS.join('}, {') + '}.');
  }
  return withLock_(function () {
    findShop_(ctx.ss, t.shop_id);
    const table = readTable_(ctx.ss, TABS.TEMPLATES);
    let row = t.template_id ? table.rows.filter(function (r) { return r.template_id === t.template_id; })[0] : null;
    if (row && row.shop_id !== t.shop_id) throw new Error('This template belongs to another shop.');
    const values = {
      shop_id: t.shop_id, template_name: name, channel: channel, subject: channel === 'email' ? subject : '',
      body: body, active: t.active === false || norm_(t.active) === 'no' ? 'no' : 'yes', updated_at: nowIso_()
    };
    if (row) {
      Object.keys(values).forEach(function (k) { row[k] = values[k]; });
      updateRow_(table, row);
    } else {
      row = Object.assign({ template_id: newId_('T') }, values);
      appendRows_(table, [row]);
    }
    return stripRow_(row);
  });
}

/* ------------------------------------------------------------------ */
/* Campaigns                                                            */
/* ------------------------------------------------------------------ */

function cleanDelay_(v) {
  const n = Number(v);
  return ALLOWED_DELAYS.indexOf(n) !== -1 ? n : DEFAULT_DELAY_MINUTES;
}

/** Works out who would receive a campaign, without saving anything. */
function planCampaign_(ss, params) {
  const shop = findShop_(ss, params.shopId);
  if (!isActive_(shop.active)) throw new Error('This shop is marked inactive in the Shops tab.');
  let template;
  if (params.subject !== undefined || params.body !== undefined) {
    // Message written on the Send page. The same text sent again counts as the same message (for "skip people who
    // already received it"); new text is saved as a new message when sending starts.
    const subject = String(params.subject || '').trim();
    const body = String(params.body || '').replace(/\s+$/, '');
    if (!subject) throw new Error('Write a subject for the email.');
    if (!body.trim()) throw new Error('Write the message.');
    if (subject.length > 250) throw new Error('The subject is too long (max 250 characters).');
    if (body.length > 20000) throw new Error('The message is too long.');
    const unknownW = unknownPlaceholders_(subject + ' ' + body);
    if (unknownW.length) {
      throw new Error('These fields are not known: ' + unknownW.join(', ') + '. You can use: {' + PLACEHOLDERS.join('}, {') + '}.');
    }
    template = readTable_(ss, TABS.TEMPLATES).rows.filter(function (t) {
      return t.shop_id === shop.shop_id && norm_(t.channel) === 'email' && t.subject === subject && t.body === body;
    })[0];
    if (!template) template = { template_id: '', template_name: '', subject: subject, body: body, _new: true };
  } else {
    template = readTable_(ss, TABS.TEMPLATES).rows.filter(function (t) {
      return t.template_id === params.templateId;
    })[0];
    if (!template) throw new Error('Choose an email template first.');
    if (template.shop_id !== shop.shop_id) throw new Error('That template belongs to another shop.');
    if (norm_(template.channel) !== 'email') throw new Error('That is a WhatsApp template. Choose an email template.');
    if (isNo_(template.active)) throw new Error('That template is switched off (active = no).');
  }
  if (!template.subject) throw new Error('The template has no subject.');
  if (!template.body) throw new Error('The template has no message text.');
  const unknown = unknownPlaceholders_(template.subject + ' ' + template.body);
  if (unknown.length) throw new Error('The template uses unknown fields: ' + unknown.join(', ') + '. Fix it in Templates.');

  const contacts = readTable_(ss, TABS.CONTACTS).rows.filter(function (c) { return c.shop_id === shop.shop_id; });
  const skipPrevious = params.skipPrevious !== false;
  const previous = {};
  if (skipPrevious) {
    readTable_(ss, TABS.LOG).rows.forEach(function (l) {
      if (template.template_id && l.shop_id === shop.shop_id && l.template_id === template.template_id && l.status === 'sent' && l.channel === 'email') {
        previous[norm_(l.email)] = l.sent_at;
      }
    });
  }
  const seen = {};
  const plan = contacts.map(function (c) {
    const check = eligibility_(c, 'email');
    let status = check.ok ? 'pending' : 'skipped';
    let reason = check.reason;
    if (check.ok && seen[c.email]) { status = 'skipped'; reason = 'Same email appears twice in this shop\'s contacts'; }
    if (check.ok && status === 'pending' && previous[c.email]) {
      status = 'skipped'; reason = 'Already received this message on ' + String(previous[c.email]).slice(0, 10);
    }
    if (status === 'pending') seen[c.email] = true;
    return { contact: c, status: status, reason: reason };
  });
  const sample = plan.filter(function (p) { return p.status === 'pending'; })[0];
  const fields = templateFields_(sample ? sample.contact : { first_name: 'Ahmed', full_name: 'Ahmed Ali', email: 'ahmed@example.com' }, shop);
  const reasons = {};
  plan.forEach(function (p) { if (p.status === 'skipped') reasons[p.reason] = (reasons[p.reason] || 0) + 1; });
  return {
    shop: shop, template: template, plan: plan, skipPrevious: skipPrevious,
    summary: {
      totalContacts: contacts.length,
      willSend: plan.filter(function (p) { return p.status === 'pending'; }).length,
      willSkip: plan.filter(function (p) { return p.status === 'skipped'; }).length,
      skipReasons: Object.keys(reasons).map(function (r) { return { reason: r, count: reasons[r] }; })
        .sort(function (a, b) { return b.count - a.count; }),
      preview: {
        to: sample ? sample.contact.email : '(example) ahmed@example.com',
        toName: sample ? (sample.contact.full_name || sample.contact.first_name) : 'Ahmed Ali',
        from: shop.sender_email,
        fromName: shop.sender_name || shop.shop_name,
        replyTo: shop.reply_to || '',
        subject: renderText_(template.subject, fields),
        body: renderText_(template.body, fields),
        samples: plan.filter(function (p) { return p.status === 'pending'; }).slice(0, 3).map(function (p) {
          const f = templateFields_(p.contact, shop);
          return { name: p.contact.full_name || p.contact.first_name || p.contact.email, email: p.contact.email,
            firstLine: renderText_(template.body, f).split(/\r?\n/).filter(function (l) { return l.trim(); })[0] || '' };
        })
      },
      sender: senderCheck_(shop)
    }
  };
}

function getCampaignPreview(params) {
  const ctx = requireUser_();
  const p = planCampaign_(ctx.ss, params || {});
  const delay = cleanDelay_(params.delayMinutes);
  const s = p.summary;
  s.delayMinutes = delay;
  s.estimatedHours = Math.round(s.willSend * delay / 6) / 10;
  s.dailyLimitNote = s.willSend > 90
    ? 'A free Gmail account can send about 100 emails per day from apps. The rest will wait and continue automatically the next day.'
    : '';
  return s;
}

function startCampaign(params) {
  const ctx = requireUser_();
  params = params || {};
  return withLock_(function () {
    const p = planCampaign_(ctx.ss, params);
    if (!p.summary.sender.ok) throw new Error(p.summary.sender.reason);
    if (p.summary.willSend === 0) {
      throw new Error('Nobody can receive this email. ' + p.summary.skipReasons.map(function (r) {
        return r.count + ' × ' + r.reason;
      }).join('; ') + '.');
    }
    const now = nowIso_();
    const delay = cleanDelay_(params.delayMinutes);
    if (p.template._new) {
      const t = {
        template_id: newId_('T'), shop_id: p.shop.shop_id,
        template_name: (String(params.name || '').trim() || p.template.subject).slice(0, 80),
        channel: 'email', subject: p.template.subject, body: p.template.body, active: 'yes', updated_at: now
      };
      appendRows_(readTable_(ctx.ss, TABS.TEMPLATES), [t]);
      p.template = t;
    }
    const campaign = {
      campaign_id: newId_('K'), shop_id: p.shop.shop_id,
      campaign_name: String(params.name || '').trim() ||
        (p.template.template_name + ' — ' + Utilities.formatDate(new Date(), 'Asia/Dubai', 'd MMM yyyy HH:mm')),
      template_id: p.template.template_id, sender_email: norm_(p.shop.sender_email), delay_minutes: String(delay),
      skip_previous_recipients: p.skipPrevious ? 'yes' : 'no', status: 'running', status_reason: '',
      created_by: ctx.email, created_at: now, started_at: now, next_send_at: now, finished_at: '',
      total: String(p.plan.length), sent: '0', skipped: String(p.summary.willSkip), failed: '0',
      pending: String(p.summary.willSend)
    };
    const logRows = p.plan.map(function (item) {
      const c = item.contact;
      return {
        log_id: newId_('L'), campaign_id: campaign.campaign_id, shop_id: p.shop.shop_id, contact_id: c.contact_id,
        contact_name: c.full_name || c.first_name, email: c.email, phone: c.phone, template_id: p.template.template_id,
        channel: 'email', sender_email: campaign.sender_email, status: item.status, reason: item.reason,
        queued_at: now, sent_at: '', attempts: '0', done_by: item.status === 'skipped' ? 'app' : ''
      };
    });
    appendRows_(readTable_(ctx.ss, TABS.CAMPAIGNS), [campaign]);
    appendRows_(readTable_(ctx.ss, TABS.LOG), logRows);
    setNextDue_(Date.now());
    return stripRow_(campaign);
  });
}

function setCampaignStatus_(campaignId, action) {
  const ctx = requireUser_();
  return withLock_(function () {
    const table = readTable_(ctx.ss, TABS.CAMPAIGNS);
    const c = table.rows.filter(function (r) { return r.campaign_id === campaignId; })[0];
    if (!c) throw new Error('Campaign not found. Reload the page.');
    if (c.status === 'completed' || c.status === 'stopped') throw new Error('This campaign has already ended.');
    const now = nowIso_();
    if (action === 'pause') {
      c.status = 'paused';
      c.status_reason = 'Paused by ' + ctx.email;
    } else if (action === 'resume') {
      const shop = findShop_(ctx.ss, c.shop_id);
      if (norm_(shop.sender_email) !== norm_(c.sender_email)) {
        throw new Error('The shop\'s sender email changed since this campaign started. Stop this campaign and start a new one.');
      }
      const check = senderCheck_(shop);
      if (!check.ok) throw new Error(check.reason);
      c.status = 'running';
      c.status_reason = '';
      c.next_send_at = now;
    } else if (action === 'stop') {
      c.status = 'stopped';
      c.status_reason = 'Stopped by ' + ctx.email;
      c.finished_at = now;
      const log = readTable_(ctx.ss, TABS.LOG);
      log.rows.forEach(function (l) {
        if (l.campaign_id === campaignId && l.status === 'pending') {
          l.status = 'cancelled'; l.reason = 'Campaign was stopped before this email was sent'; l.done_by = ctx.email;
          updateRow_(log, l);
        }
      });
      recount_(c, log.rows);
    }
    updateRow_(table, c);
    recomputeNextDue_(table.rows);
    return stripRow_(c);
  });
}

function pauseCampaign(id) { return setCampaignStatus_(id, 'pause'); }
function resumeCampaign(id) { return setCampaignStatus_(id, 'resume'); }
function stopCampaign(id) { return setCampaignStatus_(id, 'stop'); }

function getCampaignDetail(campaignId) {
  const ctx = requireUser_();
  const c = readTable_(ctx.ss, TABS.CAMPAIGNS).rows.filter(function (r) { return r.campaign_id === campaignId; })[0];
  if (!c) throw new Error('Campaign not found.');
  const rows = readTable_(ctx.ss, TABS.LOG).rows
    .filter(function (l) { return l.campaign_id === campaignId; })
    .map(stripRow_);
  return { campaign: stripRow_(c), rows: rows, engine: engineStatus_() };
}

function recount_(campaign, logRows) {
  const n = { sent: 0, skipped: 0, failed: 0, pending: 0, total: 0 };
  logRows.forEach(function (l) {
    if (l.campaign_id !== campaign.campaign_id) return;
    n.total++;
    if (l.status === 'sent') n.sent++;
    else if (l.status === 'failed') n.failed++;
    else if (l.status === 'pending') n.pending++;
    else n.skipped++; // skipped + cancelled
  });
  Object.keys(n).forEach(function (k) { campaign[k] = String(n[k]); });
}

/* ------------------------------------------------------------------ */
/* WhatsApp (manual, free)                                              */
/* ------------------------------------------------------------------ */

/** Records that a WhatsApp chat was opened for a contact. Sending itself is done by the person in WhatsApp. */
function logWhatsAppOpened(contactId, templateId) {
  const ctx = requireUser_();
  return withLock_(function () {
    const c = readTable_(ctx.ss, TABS.CONTACTS).rows.filter(function (r) { return r.contact_id === contactId; })[0];
    if (!c) throw new Error('Contact not found.');
    const check = eligibility_(c, 'whatsapp');
    if (!check.ok) throw new Error('Cannot message this contact: ' + check.reason + '.');
    const now = nowIso_();
    appendRows_(readTable_(ctx.ss, TABS.LOG), [{
      log_id: newId_('L'), campaign_id: 'WHATSAPP-MANUAL', shop_id: c.shop_id, contact_id: c.contact_id,
      contact_name: c.full_name || c.first_name, email: c.email, phone: c.phone, template_id: templateId || '',
      channel: 'whatsapp', sender_email: '', status: 'opened_in_whatsapp',
      reason: 'Chat opened with a prefilled message; sent by hand in WhatsApp', queued_at: now, sent_at: now,
      attempts: '1', done_by: ctx.email
    }]);
    return { at: now };
  });
}
