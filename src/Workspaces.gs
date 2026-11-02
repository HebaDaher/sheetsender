/**
 * Workspaces — every person who opens the app gets their own private space.
 *
 *  - A workspace = one Google Sheet (in its owner's own Google Drive) + its own settings: Gmail accounts, safe-sending
 *    rules, WhatsApp (Mac helper or WhatsApp Business API). Nobody can see another workspace's data.
 *  - The person who creates a workspace is its OWNER. The owner can add PEOPLE (e.g. Dad) in ⚙ Settings > People:
 *    they are given Editor access to the workspace's Sheet and can use it from the app, but cannot change settings.
 *  - Each owner's emails are sent by their OWN every-minute trigger, running as them, so their Gmail permissions
 *    (tokens) stay in their own private store (UserProperties) and are never shared with anyone.
 *  - The ADMIN is the person who installed the app (ran setup). Only the admin manages the Google sign-in client
 *    (Client ID/secret) that everyone uses to connect Gmail accounts. The admin's workspace is the original one.
 *
 * Storage (script properties — shared, non-secret):
 *   U_<hash of email>  {own, member[], current, checked}        which workspaces a person can open
 *   W_<id>             {id, owner, sheet_id, name, ...}         one workspace
 *   <NAME>@<id>        a workspace setting (ACCOUNTS, SEND_RULES, NEXT_DUE, LAST_RUN, WA_*, …)
 *   T_<sha256 token>   workspace id of a paired Mac helper (the token itself stays on that Mac)
 */

const WS_VERSION = '2';
let WS = null; // the workspace of the current request / trigger run

/** The original single-workspace settings and where they move to (one time, automatically). */
const LEGACY_KEYS = {
  GMAIL_ACCOUNTS: 'ACCOUNTS', SEND_RULES: 'SEND_RULES', WA_COMMANDS: 'WA_COMMANDS', WA_HELPER: 'WA_HELPER',
  NEXT_DUE_AT: 'NEXT_DUE', LAST_ENGINE_RUN: 'LAST_RUN'
};

function sp_() { return PropertiesService.getScriptProperties(); }
function adminEmail_() { return norm_(sp_().getProperty(PROP.OWNER_EMAIL)); }

function readJsonProp_(key, fallback) {
  try { const v = sp_().getProperty(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}
function writeJsonProp_(key, obj) {
  const s = JSON.stringify(obj);
  if (s.length > 8800) throw new Error('Too much data to save in one setting.');
  sp_().setProperty(key, s);
}

/* ---------------- people ---------------- */

function userKey_(email) { return 'U_' + sha256Hex_(norm_(email)).slice(0, 40); }

function userRec_(email) {
  const r = readJsonProp_(userKey_(email), null);
  return {
    email: norm_(email), isNew: !r,
    own: (r && r.own) || '', member: (r && Array.isArray(r.member)) ? r.member.slice() : [],
    current: (r && r.current) || '', checked: !!(r && r.checked)
  };
}
function saveUserRec_(rec) {
  writeJsonProp_(userKey_(rec.email), { own: rec.own, member: rec.member, current: rec.current, checked: rec.checked });
}

/* ---------------- workspaces ---------------- */

function getWs_(id) { return id ? readJsonProp_('W_' + id, null) : null; }
function saveWs_(ws) { writeJsonProp_('W_' + ws.id, ws); if (WS && WS.id === ws.id) WS = ws; }

/** Workspace setting names are stored as NAME@workspaceId. */
function wsKey_(name, ws) {
  const w = ws || WS;
  if (!w) throw new Error('No workspace is open.');
  return name + '@' + w.id;
}
function wsGet_(name) { return sp_().getProperty(wsKey_(name)); }
function wsSet_(name, v) { sp_().setProperty(wsKey_(name), String(v)); }
function wsDel_(name) { sp_().deleteProperty(wsKey_(name)); }
function wsJson_(name, fallback) {
  if (!WS) return fallback;
  try { const v = wsGet_(name); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}

/** Workspaces this person can open, own first. Missing ones are dropped. */
function workspaceIds_(rec) {
  const ids = [];
  if (rec.own && getWs_(rec.own)) ids.push(rec.own);
  rec.member.forEach(function (id) { if (ids.indexOf(id) === -1 && getWs_(id)) ids.push(id); });
  return ids;
}

function workspaceList_(rec) {
  return workspaceIds_(rec).map(function (id) {
    const w = getWs_(id);
    return { id: id, name: w.name || 'Workspace', owner: w.owner, mine: w.owner === rec.email };
  });
}

function editorsOf_(ss) {
  return ss.getEditors().map(function (u) { return norm_(u.getEmail()); });
}

/**
 * One-time move from the original single-owner app: the existing Sheet becomes the admin's workspace, its settings
 * move into that workspace, and the Sheet's editors (e.g. Dad) keep access automatically. Nothing is deleted.
 */
function migrate_() {
  const props = sp_();
  if (props.getProperty('WS_VERSION') === WS_VERSION) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('The app is busy updating. Please try again in a few seconds.');
  try {
    if (props.getProperty('WS_VERSION') === WS_VERSION) return;
    const sheetId = props.getProperty(PROP.SHEET_ID);
    const owner = norm_(props.getProperty(PROP.OWNER_EMAIL));
    if (sheetId && owner) {
      const ws = { id: newId_('W'), owner: owner, sheet_id: sheetId, name: 'My shops', created_at: nowIso_(),
        shared_by_sheet: true, engine_on: true };
      writeJsonProp_('W_' + ws.id, ws);
      const rec = userRec_(owner);
      rec.own = ws.id; rec.current = ws.id; rec.checked = true;
      saveUserRec_(rec);
      Object.keys(LEGACY_KEYS).forEach(function (k) {
        const v = props.getProperty(k);
        if (v !== null && v !== undefined) { props.setProperty(LEGACY_KEYS[k] + '@' + ws.id, v); props.deleteProperty(k); }
      });
      props.deleteProperty(PROP.SHEET_ID);
    }
    props.setProperty('WS_VERSION', WS_VERSION);
  } finally {
    lock.releaseLock();
  }
}

/**
 * People given Editor access to the admin's original Sheet (the way Dad was added before workspaces existed) are
 * found automatically the first time they open the app.
 */
function discoverMembership_(rec) {
  if (rec.checked && (rec.own || rec.member.length)) return rec;
  const adminWs = getWs_(userRec_(adminEmail_()).own);
  if (adminWs && adminWs.shared_by_sheet && adminWs.owner !== rec.email && rec.member.indexOf(adminWs.id) === -1) {
    try {
      const ss = SpreadsheetApp.openById(adminWs.sheet_id);
      if (editorsOf_(ss).indexOf(rec.email) !== -1) {
        rec.member.unshift(adminWs.id); // the family's original workspace comes first
        if (!rec.current) rec.current = adminWs.id;
      }
    } catch (e) { /* no access: not a member */ }
  }
  rec.checked = true;
  saveUserRec_(rec);
  return rec;
}

function signedInEmail_() {
  const email = norm_(Session.getActiveUser().getEmail());
  if (!email) throw new Error('Please sign in to your Google account and reload this page.');
  return email;
}

function noWorkspaceError_() {
  const e = new Error('You do not have a workspace yet. Reload the page and click "Create my workspace".');
  e.noWorkspace = true;
  return e;
}

/** Opens the current person's current workspace. Returns {ss, email, ws, isOwner, isAdmin}. */
function requireUser_() {
  migrate_();
  if (!adminEmail_()) throw new Error('The app is not set up yet. The owner must run "setup" once in the Apps Script editor.');
  const email = signedInEmail_();
  const rec = discoverMembership_(userRec_(email));
  const ids = workspaceIds_(rec);
  const id = ids.indexOf(rec.current) !== -1 ? rec.current : ids[0];
  if (!id) throw noWorkspaceError_();
  const ws = getWs_(id);
  let ss = null;
  try { ss = SpreadsheetApp.openById(ws.sheet_id); } catch (e) { ss = null; }
  const ok = ss && (email === ws.owner || editorsOf_(ss).indexOf(email) !== -1);
  if (!ok) {
    if (email === ws.owner) {
      throw new Error('The Google Sheet of your workspace "' + ws.name + '" cannot be opened. It may be in the trash of your Google Drive: ' +
        'restore it there, then reload this page.');
    }
    rec.member = rec.member.filter(function (x) { return x !== id; });
    if (rec.current === id) rec.current = '';
    saveUserRec_(rec);
    throw new Error('You no longer have access to "' + ws.name + '". Its owner (' + ws.owner + ') removed you, or gave you view-only access. ' +
      'Reload the page' + (rec.own || rec.member.length ? ' to open your other workspace.' : ' to create your own workspace.'));
  }
  if (rec.current !== id) { rec.current = id; saveUserRec_(rec); }
  WS = ws;
  return { ss: ss, email: email, ws: ws, isOwner: email === ws.owner, isAdmin: email === adminEmail_() };
}

/** Same as requireUser_, but only the workspace owner may continue (Settings, Gmail connections). */
function requireOwner_() {
  const ctx = requireUser_();
  if (!ctx.isOwner) throw new Error('Only the owner of this workspace (' + ctx.ws.owner + ') can change settings.');
  return ctx;
}

/** Only the person who installed the app (the Google sign-in client is shared by everyone). */
function requireAdmin_() {
  const ctx = requireOwner_();
  if (!ctx.isAdmin) throw new Error('Only the app administrator (' + adminEmail_() + ') can change the Google sign-in setup.');
  return ctx;
}

/** Makes the Sheet ready: tabs, plain-text cells, first shop and example messages. Safe to run again. */
function prepareSheet_(ss, firstShopName) {
  ss.setSpreadsheetTimeZone('Asia/Dubai');
  CORE_TABS.forEach(function (tab) { ensureTab_(ss, tab); });
  ['Sheet1', 'Feuille 1', 'ورقة1'].forEach(function (name) {
    const s = ss.getSheetByName(name);
    if (s && ss.getSheets().length > 1 && s.getLastRow() === 0) ss.deleteSheet(s);
  });
  seedExamples_(ss, firstShopName);
}

/* ---------------- API used by the web page ---------------- */

/** First visit: makes this person's own workspace (a new Google Sheet in THEIR Drive) with their first shop. */
function createMyWorkspace(name, firstShopName) {
  migrate_();
  if (!adminEmail_()) throw new Error('The app is not set up yet.');
  const email = signedInEmail_();
  const wsName = String(name || '').trim().slice(0, 60) || 'My shops';
  const shopName = String(firstShopName || '').trim().slice(0, 80);
  if (!shopName) throw new Error('Write the name of your first shop (you can add more later).');
  return withLock_(function () {
    const rec = userRec_(email);
    if (rec.own && getWs_(rec.own)) throw new Error('You already have your own workspace. Reload the page.');
    const ss = SpreadsheetApp.create(APP_NAME + ' — ' + wsName);
    prepareSheet_(ss, shopName);
    const ws = { id: newId_('W'), owner: email, sheet_id: ss.getId(), name: wsName, created_at: nowIso_() };
    saveWs_(ws);
    rec.own = ws.id; rec.current = ws.id; rec.checked = true;
    saveUserRec_(rec);
    return { id: ws.id, name: ws.name };
  });
}

/** Opens another workspace this person belongs to. */
function switchWorkspace(id) {
  migrate_();
  const email = signedInEmail_();
  const rec = userRec_(email);
  if (workspaceIds_(rec).indexOf(String(id)) === -1) throw new Error('You do not have access to that workspace. Reload the page.');
  rec.current = String(id);
  saveUserRec_(rec);
  return getBootstrap();
}

function renameWorkspace(name) {
  const ctx = requireOwner_();
  const n = String(name || '').trim().slice(0, 60);
  if (!n) throw new Error('Write a name.');
  return withLock_(function () { const ws = getWs_(ctx.ws.id); ws.name = n; saveWs_(ws); return n; });
}

function membersOf_(ctx) {
  return editorsOf_(ctx.ss).filter(function (e) { return e && e !== ctx.ws.owner; }).sort();
}

/** Owner: lets another Google account use this workspace (gives them Editor access to its Sheet). */
function addMember(email) {
  const ctx = requireOwner_();
  const addr = norm_(email);
  if (!isValidEmail_(addr)) throw new Error('Write the person\'s Google (Gmail) address.');
  if (addr === ctx.email) throw new Error('That is you — you already own this workspace.');
  return withLock_(function () {
    try { ctx.ss.addEditor(addr); } catch (e) {
      throw new Error('Google could not share the workspace with ' + addr + '. It must be a Google account (Gmail or Google Workspace). (' + e.message + ')');
    }
    const rec = userRec_(addr);
    if (rec.member.indexOf(ctx.ws.id) === -1) rec.member.push(ctx.ws.id);
    saveUserRec_(rec); // "checked" is left as it is: their first visit still finds the family's original workspace
    return membersOf_(ctx);
  });
}

/** Owner: removes a person's access. */
function removeMember(email) {
  const ctx = requireOwner_();
  const addr = norm_(email);
  if (addr === ctx.ws.owner) throw new Error('The owner cannot be removed.');
  return withLock_(function () {
    try { ctx.ss.removeEditor(addr); } catch (e) { /* already removed */ }
    const rec = userRec_(addr);
    if (!rec.isNew) {
      rec.member = rec.member.filter(function (x) { return x !== ctx.ws.id; });
      if (rec.current === ctx.ws.id) rec.current = '';
      saveUserRec_(rec);
    }
    return membersOf_(ctx);
  });
}

/** Owner: adds a shop, or changes one (name, sender name, reply-to, country code, shown/hidden). */
function saveShop(s) {
  const ctx = requireOwner_();
  s = s || {};
  const name = String(s.shop_name || '').trim().slice(0, 80);
  if (!name) throw new Error('Write the shop name.');
  const senderName = String(s.sender_name || '').trim().slice(0, 80);
  const replyTo = norm_(s.reply_to);
  if (replyTo && !isValidEmail_(replyTo)) throw new Error('The reply-to address does not look like an email address.');
  const cc = String(s.country_code || DEFAULT_COUNTRY_CODE).replace(/\D/g, '');
  if (!/^\d{1,4}$/.test(cc)) throw new Error('The country code must be 1 to 4 digits, for example 971.');
  return withLock_(function () {
    const table = readTable_(ctx.ss, TABS.SHOPS);
    let row = s.shop_id ? table.rows.filter(function (r) { return r.shop_id === s.shop_id; })[0] : null;
    if (s.shop_id && !row) throw new Error('Shop not found. Reload the page.');
    const dupe = table.rows.filter(function (r) { return r !== row && norm_(r.shop_name) === norm_(name) && isActive_(r.active); })[0];
    if (dupe) throw new Error('There is already a shop called "' + name + '".');
    const values = { shop_name: name, sender_name: senderName || name, reply_to: replyTo, country_code: cc,
      active: s.active === false ? 'no' : 'yes' };
    if (row) {
      Object.keys(values).forEach(function (k) { row[k] = values[k]; });
      updateRow_(table, row);
    } else {
      row = Object.assign({ shop_id: newId_('S'), sender_email: '', notes: 'Added in the app by ' + ctx.email }, values);
      appendRows_(table, [row]);
    }
    return publicShop_(row);
  });
}

/* ---------------- the every-minute trigger of each workspace owner ---------------- */

/** (Re)installs the every-minute sending trigger of the person running this code. */
function installTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processQueue') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processQueue').timeBased().everyMinutes(1).create();
  if (WS && norm_(Session.getEffectiveUser().getEmail()) === WS.owner && !WS.engine_on) {
    const ws = getWs_(WS.id); ws.engine_on = true; ws.engine_on_at = nowIso_(); saveWs_(ws);
  }
  try { CacheService.getUserCache().put('trigger_ok', '1', 21600); } catch (e) { /* best effort */ }
}

/** Makes sure the workspace owner's trigger exists (only possible in the owner's own session). */
function ensureTrigger_() {
  if (!WS || norm_(Session.getEffectiveUser().getEmail()) !== WS.owner) return false;
  const cache = CacheService.getUserCache();
  if (cache.get('trigger_ok') && WS.engine_on) return true;
  const has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'processQueue'; });
  if (!has) installTrigger_();
  else if (!WS.engine_on) { const ws = getWs_(WS.id); ws.engine_on = true; ws.engine_on_at = nowIso_(); saveWs_(ws); }
  cache.put('trigger_ok', '1', 21600);
  return true;
}
