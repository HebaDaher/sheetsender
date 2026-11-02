/**
 * Shop Follow-ups — a private email + WhatsApp follow-up tool for several shops.
 *
 * Stack: Google Apps Script (standalone project), HTML Service web app, one Google Sheet as the database,
 * Gmail API (through Google OAuth 2.0) to send email from each shop's own connected Gmail account.
 *
 * HOW ACCESS WORKS
 *  - The web app runs as the person who opens it ("User accessing the web app"). Anyone with a Google account can
 *    open the link and gets their OWN private workspace (a Google Sheet in their own Drive) — see Workspaces.gs.
 *  - A workspace owner can add people (e.g. Dad); they get Editor access to that workspace's Sheet.
 *  - Emails are sent by a time-based trigger that belongs to each WORKSPACE OWNER. Each shop's email goes out
 *    through the Gmail account connected for that shop (OAuth, scope gmail.send only).
 *  - Gmail refresh tokens (and a WhatsApp Business API token) live in the workspace owner's private UserProperties:
 *    only code running as that owner can read them. They are never sent to the web page or written to the Sheet.
 *
 * Files: Code.gs (data + web app API), Workspaces.gs (people + workspaces), Senders.gs (Gmail OAuth + sending),
 *        Sending.gs (queue + trigger), WhatsAppApi.gs (WhatsApp Business API), Index.html, Styles.html, App.html,
 *        SheetJS.html
 */

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const APP_NAME = 'Shop Follow-ups';
const DEFAULT_DELAY_MINUTES = 5;
const ALLOWED_DELAYS = [1, 2, 3, 5, 10, 15, 30, 60];
const MAX_SEND_ATTEMPTS = 3;
const DEFAULT_COUNTRY_CODE = '971';
const DEFAULT_DAILY_CAP = 40;      // emails per Gmail account per day (Gmail allows ~500; staying far below protects the account)
const DEFAULT_START_HOUR = 9;      // send only from 9:00 …
const DEFAULT_END_HOUR = 21;       // … until 21:00, UAE time
const SAFE_DELAYS = [3, 5, 10, 15, 30, 60]; // choices shown on the Send page
const PLACEHOLDERS = ['first_name', 'full_name', 'shop_name', 'sender_name', 'email', 'phone'];

const TABS = {
  SHOPS: 'Shops',
  CONTACTS: 'Contacts',
  TEMPLATES: 'Templates',
  CAMPAIGNS: 'Campaigns',
  LOG: 'Send Log',
  WA_TEMPLATES: 'WhatsApp API templates'
};
const CORE_TABS = ['Shops', 'Contacts', 'Templates', 'Campaigns', 'Send Log'];

const HEADERS = {
  Shops: ['shop_id', 'shop_name', 'sender_email', 'sender_name', 'reply_to', 'country_code', 'active', 'notes'],
  Contacts: ['contact_id', 'shop_id', 'full_name', 'first_name', 'email', 'phone',
    'consent_status', 'consent_source', 'consent_date', 'opted_out', 'opt_out_date', 'opt_out_reason',
    'created_at', 'updated_at', 'source_file'],
  Templates: ['template_id', 'shop_id', 'template_name', 'channel', 'subject', 'body', 'active', 'updated_at'],
  Campaigns: ['campaign_id', 'shop_id', 'campaign_name', 'template_id', 'sender_email', 'delay_minutes',
    'skip_previous_recipients', 'status', 'status_reason', 'created_by', 'created_at', 'started_at',
    'next_send_at', 'finished_at', 'total', 'sent', 'skipped', 'failed', 'pending', 'random_extra', 'ignore_hours',
    'channel', 'wa_template', 'daily_cap', 'start_hour', 'end_hour'],
  'Send Log': ['log_id', 'campaign_id', 'shop_id', 'contact_id', 'contact_name', 'email', 'phone', 'template_id',
    'channel', 'sender_email', 'status', 'reason', 'queued_at', 'sent_at', 'attempts', 'done_by'],
  'WhatsApp API templates': ['name', 'language', 'category', 'status', 'details', 'updated_at']
};

/**
 * Script properties used by the whole app. Workspace settings are stored per workspace (see Workspaces.gs):
 * ACCOUNTS@id {email: {status, connected_at, last_error, ...}} (no tokens), SEND_RULES@id, NEXT_DUE@id, LAST_RUN@id,
 * WA_COMMANDS@id, WA_HELPER@id, WA_API@id (no token).
 */
const PROP = {
  SHEET_ID: 'SHEET_ID',                // original single-workspace Sheet (moved into a workspace, then removed)
  OWNER_EMAIL: 'OWNER_EMAIL',          // the app administrator (the person who installed it and ran setup)
  OAUTH_CLIENT_ID: 'OAUTH_CLIENT_ID',  // public identifier, not a secret
  OAUTH_CLIENT_SECRET: 'OAUTH_CLIENT_SECRET' // server-side only, never returned to any page
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
 * Run ONCE by the app administrator from the Apps Script editor (select "setup" and press Run).
 * Creates the administrator's workspace (or repairs it) and installs the sending trigger. Safe to run again.
 */
function setup() {
  migrate_();
  const props = PropertiesService.getScriptProperties();
  const me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  const existingOwner = String(props.getProperty(PROP.OWNER_EMAIL) || '').toLowerCase();
  if (!me) throw new Error('Could not read your Google account email. Please try again.');
  if (existingOwner && existingOwner !== me) {
    throw new Error('Setup was already done by ' + existingOwner + '. Only that account can run setup again.');
  }
  props.setProperty(PROP.OWNER_EMAIL, me);
  const rec = userRec_(me);
  let ws = getWs_(rec.own), ss;
  if (ws) {
    ss = SpreadsheetApp.openById(ws.sheet_id);
  } else {
    ss = SpreadsheetApp.create(APP_NAME + ' — Database');
    ws = { id: newId_('W'), owner: me, sheet_id: ss.getId(), name: 'My shops', created_at: nowIso_(), shared_by_sheet: true };
    saveWs_(ws);
    rec.own = ws.id; rec.current = ws.id; rec.checked = true;
    saveUserRec_(rec);
  }
  WS = ws;
  prepareSheet_(ss, 'Example Shop');
  installTrigger_();

  const msg = 'Setup finished.\nAdministrator: ' + me + '\nYour workspace Sheet: ' + ss.getUrl() +
    '\nNext: open the app link, go to Settings, save the Google sign-in client and connect Gmail accounts.';
  Logger.log(msg);
  return msg;
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

function seedExamples_(ss, shopName) {
  const shops = readTable_(ss, TABS.SHOPS);
  if (shops.rows.length > 0) return;
  const now = nowIso_();
  const name = shopName || 'Example Shop';
  appendRows_(shops, [{
    shop_id: 'SHOP1', shop_name: name, sender_email: '', sender_name: name,
    reply_to: '', country_code: DEFAULT_COUNTRY_CODE, active: 'yes',
    notes: 'Add, rename or hide shops in the app: Settings > Shops. Choose the sending Gmail there too.'
  }]);
  const templates = readTable_(ss, TABS.TEMPLATES);
  appendRows_(templates, [
    {
      template_id: 'T1', shop_id: 'SHOP1', template_name: 'Follow-up email', channel: 'email',
      subject: 'Still interested in {shop_name}?',
      body: 'Hi {first_name},\n\nThank you for your interest in {shop_name}. The shop is still available and ' +
        'I would be happy to share the details or arrange a visit.\n\nJust reply to this email and I will get back to you.\n\n' +
        'Best regards,\n{sender_name}\n\nIf you are no longer interested, just reply and let me know, and I will not email you again.',
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

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('The app is busy (another action is running). Please try again in a few seconds.');
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ------------------------------------------------------------------ */
/* Sheet helpers                                                        */
/* ------------------------------------------------------------------ */

function readTable_(ss, tab) {
  const sheet = ss.getSheetByName(tab) || ensureTab_(ss, tab); // a deleted or new tab is made again (empty)
  const values = sheet.getLastRow() > 0 ? sheet.getDataRange().getValues() : [[]];
  let headers = (values[0] || []).map(function (h) { return String(h).trim(); });
  // Columns added in newer versions of the app are added to the end of the tab automatically.
  const missing = HEADERS[tab].filter(function (h) { return headers.indexOf(h) === -1; });
  if (missing.length) {
    if (!headers.filter(String).length) {
      throw new Error('The "' + tab + '" tab of the Google Sheet has no header row (the first row was deleted). Delete the "' + tab + '" tab and reload: it is made again.');
    }
    while (headers.length && !headers[headers.length - 1]) headers.pop();
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    headers = headers.concat(missing);
  }
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
  let ctx;
  try {
    ctx = requireUser_();
  } catch (e) {
    if (!e.noWorkspace) throw e;
    // First visit: nothing yet. The page offers "Create my workspace".
    return { needsWorkspace: true, user: signedInEmail_(), admin: adminEmail_(), appName: APP_NAME };
  }
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
    const accounts = accountStatus_();
    const connected = Object.keys(accounts).filter(function (k) { return accounts[k].status === 'connected'; });
    if (!props.getProperty(PROP.OAUTH_CLIENT_ID)) {
      settingsNeeded = ctx.isAdmin
        ? 'save the Google sign-in Client ID and secret, then connect the shops\' Gmail accounts.'
        : 'Gmail sending is not available yet: the app administrator (' + adminEmail_() + ') still has to finish the Google sign-in setup.';
    } else if (!connected.length) settingsNeeded = 'connect at least one Gmail account.';
    else if (shops.some(function (s) { return !s.senderOk; })) settingsNeeded = 'some shops have no connected Gmail account chosen.';
    if (ctx.ws.engine_on) ensureTrigger_(); // puts the sender back if it was removed
  }
  const rec = userRec_(ctx.email);
  return {
    user: ctx.email,
    isOwner: ctx.isOwner,
    isAdmin: ctx.isAdmin,
    settingsNeeded: settingsNeeded,
    owner: ctx.ws.owner,
    workspace: { id: ctx.ws.id, name: ctx.ws.name || 'My shops' },
    workspaces: workspaceList_(rec),
    ownsWorkspace: !!(rec.own && getWs_(rec.own)),
    shops: shops,
    setupProblems: problems,
    engine: engineStatus_(),
    defaultDelay: DEFAULT_DELAY_MINUTES,
    allowedDelays: SAFE_DELAYS,
    sendingRules: sendingRules_(),
    placeholders: PLACEHOLDERS,
    sheetUrl: ctx.ss.getUrl()
  };
}

function engineStatus_() {
  const last = WS ? wsGet_('LAST_RUN') : '';
  const minutes = last ? Math.round((Date.now() - new Date(last).getTime()) / 60000) : null;
  // A new workspace has no trigger until its owner connects something: nothing to warn about yet.
  if (!last && !(WS && WS.engine_on)) return { lastRun: '', minutesAgo: null, healthy: true, notStarted: true };
  // Just switched on: its first run comes within a minute or two.
  if (!last && WS.engine_on_at && Date.now() - new Date(WS.engine_on_at).getTime() < 5 * 60000) return { lastRun: '', minutesAgo: null, healthy: true };
  return { lastRun: last || '', minutesAgo: minutes, healthy: minutes !== null && minutes <= 10 };
}

function getShopData(shopId) {
  const ctx = requireUser_();
  importRelayResults_(ctx.ss); // WhatsApp results the Mac sent while nobody had the app open
  const shop = findShop_(ctx.ss, shopId);
  const templates = readTable_(ctx.ss, TABS.TEMPLATES).rows
    .filter(function (t) { return t.shop_id === shopId && !isDeletedTemplate_(t); })
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
  return { shop: publicShop_(shop), templates: templates, contacts: contacts, campaigns: campaigns, engine: engineStatus_(),
    waApi: waApiPublic_(false) };
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

/**
 * Removes a saved message from the menus. It is only hidden (marked "deleted"), so sends that already use it keep
 * working and the history stays correct. Writing the exact same text again brings it back.
 */
function deleteTemplate(templateId, shopId) {
  const ctx = requireUser_();
  return withLock_(function () {
    const table = readTable_(ctx.ss, TABS.TEMPLATES);
    const row = table.rows.filter(function (r) { return r.template_id === templateId; })[0];
    if (!row) throw new Error('This message was not found. Reload the page.');
    if (shopId && row.shop_id !== shopId) throw new Error('This message belongs to another shop.');
    row.active = 'deleted';
    row.updated_at = nowIso_();
    updateRow_(table, row);
    return true;
  });
}

function isDeletedTemplate_(t) { return norm_(t.active) === 'deleted'; }

/** A saved message matched by its exact text comes back to the menus when it is used again. */
function reviveTemplate_(ss, template) {
  if (!template || !template._row || !isDeletedTemplate_(template)) return;
  const table = readTable_(ss, TABS.TEMPLATES);
  const row = table.rows.filter(function (r) { return r.template_id === template.template_id; })[0];
  if (row) { row.active = 'yes'; row.updated_at = nowIso_(); updateRow_(table, row); template.active = 'yes'; }
}

/* ------------------------------------------------------------------ */
/* Campaigns                                                            */
/* ------------------------------------------------------------------ */

/** Minutes between messages: any whole number from 1 to 120 (the screens offer 3 or more). */
function cleanDelay_(v) {
  const n = Math.round(Number(v));
  return n >= 1 && n <= 120 ? n : DEFAULT_DELAY_MINUTES;
}

/** Optional start time chosen on the screen. Returns ms, or 0 for "now". */
function cleanStartAt_(v) {
  if (!v) return 0;
  const t = new Date(v).getTime();
  if (isNaN(t)) throw new Error('The start time is not valid. Choose a date and time again.');
  if (t < Date.now() - 5 * 60000) throw new Error('The start time is in the past. Choose a later time, or choose "Now".');
  if (t > Date.now() + 60 * 24 * 3600 * 1000) throw new Error('The start time is more than 60 days away.');
  return t > Date.now() ? t : 0;
}

function fmtUae_(ms) {
  const d = new Date(ms + 4 * 3600 * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' ' + ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2);
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
  s.randomExtra = params.randomExtra !== false;
  const startMsP = cleanStartAt_(params.startAt);
  s.startAtLabel = startMsP ? fmtUae_(startMsP) : '';
  s.ignoreHours = params.ignoreHours === true;
  // When will the first email really go out? (the sending hours can push "now" to the next morning)
  const firstMs = startMsP || Date.now();
  if (!s.ignoreHours && !withinSendingHours_(firstMs, sendingRules_())) {
    s.waitsForHoursLabel = fmtUae_(nextWindowStart_(firstMs, sendingRules_()));
  }
  s.estimatedHours = Math.round(s.willSend * delay * 1.2 / 6) / 10;
  const rules = sendingRules_();
  s.rules = rules;
  s.estimatedDays = Math.max(1, Math.ceil(s.willSend / rules.dailyCap));
  s.dailyLimitNote = s.willSend > rules.dailyCap
    ? 'To protect the Gmail account, at most ' + rules.dailyCap + ' emails go out per day. The rest continue automatically on the next days (about ' + s.estimatedDays + ' days in total).'
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
    const startMs = cleanStartAt_(params.startAt);
    reviveTemplate_(ctx.ss, p.template);
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
      skip_previous_recipients: p.skipPrevious ? 'yes' : 'no', status: 'running',
      status_reason: startMs ? 'Scheduled: the first email goes out at ' + fmtUae_(startMs) + ' (UAE time).' : '',
      created_by: ctx.email, created_at: now, started_at: startMs ? new Date(startMs).toISOString() : now,
      next_send_at: startMs ? new Date(startMs).toISOString() : now, finished_at: '',
      total: String(p.plan.length), sent: '0', skipped: String(p.summary.willSkip), failed: '0',
      pending: String(p.summary.willSend), random_extra: params.randomExtra === false ? 'no' : 'yes',
      ignore_hours: params.ignoreHours === true ? 'yes' : 'no'
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
    setNextDue_(startMs || Date.now());
    ensureTrigger_();
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
      if (c.channel === 'whatsapp_api') {
        const cfg = waApiCfg_();
        if (!cfg || cfg.status !== 'connected') {
          throw new Error('WhatsApp Business API is not connected. ' + ctx.ws.owner + ' must reconnect it in ⚙ Settings > WhatsApp Business API first.');
        }
      } else {
        if (norm_(shop.sender_email) !== norm_(c.sender_email)) {
          throw new Error('The shop\'s sender email changed since this campaign started. Stop this campaign and start a new one.');
        }
        const check = senderCheck_(shop);
        if (!check.ok) throw new Error(check.reason);
      }
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
          l.status = 'cancelled'; l.reason = 'Stopped before this message was sent'; l.done_by = ctx.email;
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

/* ------------------------------------------------------------------ */
/* WhatsApp — automatic sending on the user's Mac                       */
/* ------------------------------------------------------------------ */

const WA_DEFAULTS = { delayMinutes: 5, dailyCap: 30, startHour: 9, endHour: 21, randomExtra: true, startAt: '' };

/**
 * Schedule chosen on the WhatsApp tab, checked. From the Mac: at least 3 minutes between messages, at most 60 per day.
 * With the WhatsApp Business API (lim = WA_API_LIMITS): at least 1 minute, at most 1000 per day.
 */
function whatsAppRules_(p, lim) {
  lim = lim || { minDelay: 3, maxCap: 60 };
  const delay = Math.round(Number(p.delayMinutes || WA_DEFAULTS.delayMinutes));
  if (!(delay >= lim.minDelay && delay <= 120)) {
    throw new Error('Minutes between WhatsApp messages must be from ' + lim.minDelay + ' to 120.' + (lim.minDelay === 3 ? ' 5 or more is safest.' : ''));
  }
  const cap = Math.round(Number(p.dailyCap || WA_DEFAULTS.dailyCap));
  if (!(cap >= 1 && cap <= lim.maxCap)) {
    throw new Error('WhatsApp messages per day must be from 1 to ' + lim.maxCap + '.' + (lim.maxCap === 60 ? ' 30 or fewer is safest.' : ''));
  }
  let sh = p.startHour === undefined ? WA_DEFAULTS.startHour : Math.round(Number(p.startHour));
  let eh = p.endHour === undefined ? WA_DEFAULTS.endHour : Math.round(Number(p.endHour));
  if (p.ignoreHours === true) { sh = 0; eh = 24; } // "Send now anyway": no sending-hours limit for this send
  if (!(sh >= 0 && sh <= 23 && eh >= 1 && eh <= 24 && eh > sh)) throw new Error('Choose sending hours where the end is after the start.');
  const startMs = cleanStartAt_(p.startAt);
  return { delayMinutes: delay, dailyCap: cap, startHour: sh, endHour: eh, randomExtra: p.randomExtra !== false,
    startAt: startMs ? new Date(startMs).toISOString() : '' };
}

/**
 * Makes the list for the Mac sender: only people who agreed, are not opted out, have a valid phone and have not
 * already received this WhatsApp message. Each item carries the personal text ("Hello Heba, …").
 * params: {shopId, templateId?, body?, skipPrevious}
 */
function getWhatsAppJob(params) {
  const ctx = requireUser_();
  params = params || {};
  const rules = whatsAppRules_(params); // check the schedule first
  return withLock_(function () { return buildWhatsAppJob_(ctx.ss, params, rules, ctx.email); });
}

function buildWhatsAppJob_(ss, params, rules, actor) {
  const ctx = { ss: ss, email: actor };
  {
    const shop = findShop_(ctx.ss, params.shopId);
    const templates = readTable_(ctx.ss, TABS.TEMPLATES);
    let template = null;
    if (params.body !== undefined) {
      const body = String(params.body || '').trim();
      if (!body) throw new Error('Write the WhatsApp message.');
      if (body.length > 3000) throw new Error('The message is too long for WhatsApp (max 3000 characters).');
      const unknown = unknownPlaceholders_(body);
      if (unknown.length) throw new Error('These fields are not known: ' + unknown.join(', ') + '. You can use: {' + PLACEHOLDERS.join('}, {') + '}.');
      template = templates.rows.filter(function (t) { return t.shop_id === shop.shop_id && norm_(t.channel) === 'whatsapp' && t.body === body; })[0];
      reviveTemplate_(ctx.ss, template);
      if (!template) {
        template = { template_id: newId_('T'), shop_id: shop.shop_id, template_name: body.split(/\r?\n/)[0].slice(0, 60),
          channel: 'whatsapp', subject: '', body: body, active: 'yes', updated_at: nowIso_() };
        appendRows_(templates, [template]);
      }
    } else {
      template = templates.rows.filter(function (t) { return t.template_id === params.templateId; })[0];
      if (!template || template.shop_id !== shop.shop_id || norm_(template.channel) !== 'whatsapp') throw new Error('Choose a WhatsApp message.');
    }
    const already = {};
    if (params.skipPrevious !== false) {
      readTable_(ctx.ss, TABS.LOG).rows.forEach(function (l) {
        if (l.shop_id === shop.shop_id && l.channel === 'whatsapp' && l.status === 'sent' && l.template_id === template.template_id) already[l.phone] = true;
      });
    }
    const items = [], skipped = {};
    const seen = {};
    readTable_(ctx.ss, TABS.CONTACTS).rows.filter(function (c) { return c.shop_id === shop.shop_id; }).forEach(function (c) {
      const check = eligibility_(c, 'whatsapp');
      let reason = check.ok ? '' : check.reason;
      if (!reason && seen[c.phone]) reason = 'Same phone number appears twice';
      if (!reason && already[c.phone]) reason = 'Already received this WhatsApp message';
      if (reason) { skipped[reason] = (skipped[reason] || 0) + 1; return; }
      seen[c.phone] = true;
      items.push({ contact_id: c.contact_id, name: c.full_name || c.first_name || '', phone: c.phone,
        text: renderText_(template.body, templateFields_(c, shop)) });
    });
    if (!items.length) {
      throw new Error('Nobody can receive this WhatsApp message. ' + Object.keys(skipped).map(function (r) { return skipped[r] + ' × ' + r; }).join('; ') + '.');
    }
    return {
      kind: 'shop-followups-whatsapp-job', version: 1,
      job_id: newId_('W'), shop_id: shop.shop_id, shop_name: shop.shop_name, template_id: template.template_id,
      created_at: nowIso_(), created_by: ctx.email, rules: rules,
      items: items,
      skipped: Object.keys(skipped).map(function (r) { return { reason: r, count: skipped[r] }; })
    };
  }
}

/** Records the results file that the Mac sender wrote. Safe to upload twice (nothing is counted twice). */
function importWhatsAppResults(results) {
  const ctx = requireUser_();
  return withLock_(function () { return recordWhatsAppResults_(ctx.ss, results, ctx.email); });
}

function recordWhatsAppResults_(ss, results, actor) {
  const ctx = { ss: ss, email: actor };
  if (!results || results.kind !== 'shop-followups-whatsapp-results' || !results.job_id || !Array.isArray(results.items)) {
    throw new Error('This is not a WhatsApp results file. Choose the file that ends with "-results.json".');
  }
  if (results.items.length > 2000) throw new Error('Too many rows.');
  {
    const shop = findShop_(ctx.ss, results.shop_id);
    const contacts = indexBy_(readTable_(ctx.ss, TABS.CONTACTS).rows, 'contact_id');
    const log = readTable_(ctx.ss, TABS.LOG);
    const campaignId = 'WHATSAPP-' + String(results.job_id).replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
    const done = {};
    log.rows.forEach(function (l) { if (l.campaign_id === campaignId) done[l.contact_id] = true; });
    const rows = [], n = { sent: 0, failed: 0, already: 0 };
    results.items.forEach(function (it) {
      const c = contacts[it.contact_id];
      if (!c || c.shop_id !== shop.shop_id) return;
      if (it.status !== 'sent' && it.status !== 'failed') return;
      if (done[c.contact_id]) { n.already++; return; }
      done[c.contact_id] = true;
      n[it.status]++;
      rows.push({
        log_id: newId_('L'), campaign_id: campaignId, shop_id: shop.shop_id, contact_id: c.contact_id,
        contact_name: c.full_name || c.first_name, email: c.email, phone: c.phone, template_id: String(results.template_id || ''),
        channel: 'whatsapp', sender_email: '', status: it.status,
        reason: it.status === 'sent' ? 'Sent automatically from WhatsApp on the Mac' : String(it.reason || 'Not sent').slice(0, 300),
        queued_at: String(results.created_at || ''), sent_at: String(it.at || nowIso_()), attempts: '1', done_by: ctx.email
      });
    });
    appendRows_(log, rows);
    return n;
  }
}


/* ------------------------------------------------------------------ */
/* WhatsApp helper on the Mac: commands, status and the secure bridge    */
/* ------------------------------------------------------------------ */
/*
 * The helper on the Mac cannot be reached by the web page (browsers block that), so it calls the app instead:
 * every few seconds it POSTs to a separate "bridge" deployment of this same script (it runs as the app
 * administrator) with its secret token. The token tells the bridge which workspace the Mac belongs to:
 *   - the administrator's original Mac: BRIDGE_TOKEN_SHA256 in Bridge.config.gs (made by the WhatsApp installer);
 *   - any other Mac: paired from the WhatsApp tab ("Set up a Mac"); the app keeps only the token's SHA-256.
 * The page leaves commands (start / stop / open WhatsApp) and, when starting, the ready-made send list; the helper
 * picks them up, reports its status and sends each result back. Results for a workspace the bridge cannot open
 * (every workspace except the administrator's) wait in a small relay until a member of that workspace opens the
 * app or its owner's trigger runs; then they are written to that workspace's Send Log.
 */

const WA_HELPER_ONLINE_S = 45;
const MAC_INSTALL_URL = 'https://hebadaher.github.io/sheetsender/mac/install.sh';
const JOB_CACHE_S = 21600; // the send list waits up to 6 hours for the Mac to fetch it (it fetches it within seconds)

function waCommands_() { return wsJson_('WA_COMMANDS', []); }
function saveWaCommands_(list) { wsSet_('WA_COMMANDS', JSON.stringify(list.slice(-10))); }
function helperStatus_() {
  const st = wsJson_('WA_HELPER', {}) || {};
  const age = st.seen_at ? Math.round((Date.now() - new Date(st.seen_at).getTime()) / 1000) : null;
  st.online = age !== null && age <= WA_HELPER_ONLINE_S;
  st.age_s = age;
  return st;
}

function bridgeConfigured_() {
  return typeof BRIDGE_TOKEN_SHA256 !== 'undefined' && /^[0-9a-f]{64}$/.test(String(BRIDGE_TOKEN_SHA256));
}
function bridgeUrl_() {
  return typeof BRIDGE_URL !== 'undefined' && /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(String(BRIDGE_URL))
    ? String(BRIDGE_URL) : '';
}
/** Is a Mac linked to the current workspace? */
function macLinked_() {
  return !!(WS && (WS.mac_token || (bridgeConfigured_() && WS.owner === adminEmail_() && WS.id === userRec_(adminEmail_()).own)));
}

/** For the WhatsApp tab: is the helper running, is WhatsApp connected, how is the current send going. */
function getWhatsAppHelper() {
  const ctx = requireUser_();
  importRelayResults_(ctx.ss);
  const st = helperStatus_();
  st.pending = waCommands_().map(function (c) { return { type: c.type, at: c.at }; });
  st.installed = macLinked_();
  st.canLink = !!bridgeUrl_();
  st.linkedAt = ctx.ws.mac_linked_at || '';
  return st;
}

function queueWaCommand_(cmd) {
  return withLock_(function () {
    const list = waCommands_().filter(function (c) { return !(cmd.type === 'start' && c.type === 'start'); });
    cmd.id = cmd.id || newId_('M'); cmd.at = nowIso_();
    list.push(cmd);
    saveWaCommands_(list);
    return cmd;
  });
}

/** Keeps the ready-made send list for the Mac (in pieces: one cache value holds at most 100 KB). */
function putJob_(commandId, job) {
  const cache = CacheService.getScriptCache();
  const text = JSON.stringify(job);
  const parts = [];
  for (let i = 0; i < text.length; i += 90000) parts.push(text.slice(i, i + 90000));
  if (parts.length > 40) throw new Error('This send list is too big. Split the contacts into smaller files.');
  parts.forEach(function (p, i) { cache.put('JOB_' + commandId + '_' + i, p, JOB_CACHE_S); });
  cache.put('JOB_' + commandId, String(parts.length), JOB_CACHE_S);
}
function getJob_(commandId) {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get('JOB_' + commandId) || 0);
  if (!n) return null;
  let text = '';
  for (let i = 0; i < n; i++) {
    const p = cache.get('JOB_' + commandId + '_' + i);
    if (p === null || p === undefined) return null;
    text += p;
  }
  try { return JSON.parse(text); } catch (e) { return null; }
}

/** Start sending now (or at the chosen time). Checks everything first so mistakes show on the page. */
function startWhatsAppAuto(params) {
  const ctx = requireUser_();
  params = params || {};
  const rules = whatsAppRules_(params);
  if (!macLinked_()) throw new Error('No Mac is set up for this workspace yet. Click "Set up a Mac" below first.');
  const st = helperStatus_();
  if (!st.online) throw new Error('The WhatsApp Sender on the Mac is not running. Turn on the Mac (and log in), wait a minute, then try again.');
  if (st.job && st.job.state === 'running') throw new Error('A WhatsApp send is already running (' + (st.job.shop_name || '') + '). Stop it first.');
  // Build once now: saves a new message, makes sure somebody can receive it, and is what the Mac will send.
  const job = withLock_(function () { return buildWhatsAppJob_(ctx.ss, params, rules, ctx.email); });
  const id = newId_('M');
  putJob_(id, job);
  queueWaCommand_({ id: id, type: 'start', by: ctx.email, params: {
    shopId: params.shopId, templateId: job.template_id, skipPrevious: params.skipPrevious !== false,
    delayMinutes: rules.delayMinutes, randomExtra: rules.randomExtra, dailyCap: rules.dailyCap,
    startHour: rules.startHour, endHour: rules.endHour, startAt: rules.startAt } });
  return { people: job.items.length, skipped: job.skipped, rules: rules, template_id: job.template_id };
}

function stopWhatsAppAuto() { const ctx = requireUser_(); queueWaCommand_({ type: 'stop', by: ctx.email }); return true; }
function openWhatsAppOnMac() { const ctx = requireUser_(); queueWaCommand_({ type: 'open', by: ctx.email }); return true; }

/**
 * "Set up a Mac": makes a new secret token for this workspace and returns the one line to paste in the Mac's
 * Terminal. Shown once; the app keeps only its fingerprint. A Mac set up earlier for this workspace is disconnected.
 */
function createMacLink() {
  const ctx = requireUser_();
  const url = bridgeUrl_();
  if (!url) {
    throw new Error('Setting up a Mac is not available on this app yet: the app administrator (' + adminEmail_() +
      ') must run Install.command on their Mac once more to publish the update.');
  }
  return withLock_(function () {
    const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    const ws = getWs_(ctx.ws.id);
    if (ws.mac_token) sp_().deleteProperty('T_' + ws.mac_token);
    const sha = sha256Hex_(token);
    sp_().setProperty('T_' + sha, ws.id);
    ws.mac_token = sha; ws.mac_linked_at = nowIso_(); ws.mac_linked_by = ctx.email;
    saveWs_(ws);
    wsDel_('WA_HELPER');
    return { command: "curl -fsSL " + MAC_INSTALL_URL + " | bash -s -- '" + url + "' '" + token + "'" };
  });
}

/* ---------------- relay of results for workspaces the bridge cannot open ---------------- */

function relayPrefix_(ws) { return 'WAR@' + (ws || WS).id + '@'; }

function relayAdd_(results) {
  if (!results || results.kind !== 'shop-followups-whatsapp-results' || !Array.isArray(results.items)) throw new Error('bad results');
  if (results.items.length > 2000) throw new Error('Too many rows.');
  const props = sp_();
  const prefix = relayPrefix_();
  if (props.getKeys().filter(function (k) { return k.indexOf(prefix) === 0; }).length > 60) {
    throw new Error('busy: results are waiting to be saved; trying again later');
  }
  const head = {};
  Object.keys(results).forEach(function (k) { if (k !== 'items') head[k] = results[k]; });
  let chunk = [];
  const flush = function () {
    if (!chunk.length) return;
    props.setProperty(prefix + Date.now() + '_' + newId_('R'), JSON.stringify(Object.assign({}, head, { items: chunk })));
    chunk = [];
  };
  results.items.forEach(function (it) {
    const small = { contact_id: String(it.contact_id || '').slice(0, 40), phone: String(it.phone || '').slice(0, 20),
      status: String(it.status || ''), reason: String(it.reason || '').slice(0, 200), at: String(it.at || '').slice(0, 30) };
    if (JSON.stringify(chunk.concat([small])).length > 7000) flush();
    chunk.push(small);
  });
  flush();
}

/** Writes waiting WhatsApp results into this workspace's Send Log (called from the page and the owner's trigger). */
function importRelayResults_(ss) {
  if (!WS) return 0;
  const props = sp_();
  const prefix = relayPrefix_();
  const keys = props.getKeys().filter(function (k) { return k.indexOf(prefix) === 0; }).sort();
  if (!keys.length) return 0;
  return withLock_(function () {
    let n = 0;
    keys.forEach(function (k) {
      const v = props.getProperty(k);
      if (v) { try { recordWhatsAppResults_(ss, JSON.parse(v), 'WhatsApp Sender (Mac)'); n++; } catch (e) { /* unusable: dropped */ } }
      props.deleteProperty(k);
    });
    return n;
  });
}

function sha256Hex_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Which workspace does this Mac token belong to? */
function workspaceForToken_(token) {
  if (!token) return null;
  const sha = sha256Hex_(token);
  if (bridgeConfigured_() && sha === String(BRIDGE_TOKEN_SHA256)) return getWs_(userRec_(adminEmail_()).own);
  const id = sp_().getProperty('T_' + sha);
  const ws = id ? getWs_(id) : null;
  return ws && ws.mac_token === sha ? ws : null;
}

/** The bridge. Only Mac helpers with a valid token; each sees only its own workspace. */
function doPost(e) {
  let req = {};
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return jsonOut_({ ok: false, error: 'bad request' }); }
  try { migrate_(); } catch (err) { return jsonOut_({ ok: false, error: 'busy' }); }
  const ws = workspaceForToken_(req.token);
  if (!ws) return jsonOut_({ ok: false, error: 'not allowed' });
  WS = ws;
  const me = norm_(Session.getEffectiveUser().getEmail());
  try {
    if (req.action === 'poll') {
      const status = req.status || {};
      status.seen_at = nowIso_();
      wsSet_('WA_HELPER', JSON.stringify(status).slice(0, 4000));
      return jsonOut_({ ok: true, commands: waCommands_() });
    }
    if (req.action === 'ack') {
      const ids = req.ids || [];
      withLock_(function () { saveWaCommands_(waCommands_().filter(function (c) { return ids.indexOf(c.id) === -1; })); });
      return jsonOut_({ ok: true });
    }
    if (req.action === 'job') {
      const cmd = waCommands_().filter(function (c) { return c.id === req.command_id && c.type === 'start'; })[0];
      if (!cmd) return jsonOut_({ ok: false, error: 'no such command' });
      let job = getJob_(cmd.id);
      if (!job && ws.owner === me) { // older command (before this update): build it here
        const ss = SpreadsheetApp.openById(ws.sheet_id);
        job = withLock_(function () { return buildWhatsAppJob_(ss, cmd.params, whatsAppRules_(cmd.params), cmd.by); });
      }
      if (!job) return jsonOut_({ ok: false, error: 'This send list expired. Press Start sending again in the app.' });
      return jsonOut_({ ok: true, job: job });
    }
    if (req.action === 'results') {
      if (ws.owner === me) {
        const ss = SpreadsheetApp.openById(ws.sheet_id);
        const n = withLock_(function () { return recordWhatsAppResults_(ss, req.results, 'WhatsApp Sender (Mac)'); });
        return jsonOut_({ ok: true, saved: n });
      }
      withLock_(function () { relayAdd_(req.results); });
      return jsonOut_({ ok: true, saved: { relayed: true } });
    }
    return jsonOut_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}
