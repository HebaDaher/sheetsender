/**
 * Workspaces and sign-in — every person who opens the link gets their own private space.
 *
 * HOW SIGN-IN WORKS (no "unverified app" screen to get in)
 *  - The web app runs as the app ADMINISTRATOR (the person who installed it): "Execute as: Me", "Anyone".
 *    Visitors authorize nothing in Apps Script, so Google shows them no permission or warning screen.
 *  - A visitor clicks "Sign in with Google": Google's own page asks only to share their email address
 *    (scopes openid + email, which Google does not treat as sensitive). The server checks Google's answer and gives
 *    the page a signed session (HMAC, 30 days). Every call from the page goes through api(session, fn, args); the
 *    session decides who the person is. Nothing else in the code trusts the browser about identity.
 *  - Works with several Google accounts in one browser: the person chooses the account on Google's page.
 *
 * WORKSPACES
 *  - A workspace = one Google Sheet + its own settings: Gmail accounts, safe-sending rules, WhatsApp. Its Sheet is
 *    kept in the administrator's Google Drive and shared (Editor) with its owner, so the owner can open it in Sheets.
 *  - The person who creates a workspace is its OWNER. Owners add PEOPLE (e.g. Dad) in ⚙ Settings > People; people use
 *    the workspace through the app only, and cannot change settings.
 *  - Gmail / WhatsApp Business API tokens of every workspace stay in the administrator's private server store
 *    (UserProperties), under that workspace's own keys. They are never sent to a page or written to a Sheet.
 *  - ONE every-minute trigger (the administrator's) sends for all workspaces.
 *
 * Storage (script properties — shared, non-secret; read through a cache to stay inside Google's daily limits):
 *   U_<hash of email>  {own, member[], current}           which workspaces a person can open
 *   W_<id>             {id, owner, sheet_id, name, members[], ...}
 *   <NAME>@<id>        a workspace setting (ACCOUNTS, SEND_RULES, NEXT_DUE, WA_*, …)
 *   T_<sha256 token>   workspace id of a paired Mac helper (the token itself stays on that Mac)
 */

const WS_VERSION = '3';

let WS = null; // the workspace of the current request / trigger run

/** The original single-workspace settings and where they move to (one time, automatically). */
const LEGACY_KEYS = {
  GMAIL_ACCOUNTS: 'ACCOUNTS', SEND_RULES: 'SEND_RULES', WA_COMMANDS: 'WA_COMMANDS', WA_HELPER: 'WA_HELPER',
  NEXT_DUE_AT: 'NEXT_DUE', LAST_ENGINE_RUN: 'LAST_RUN'
};

/*
 * Script properties, read through the script cache. Google allows about 50,000 property reads/writes a day for the
 * whole app (it all runs as the administrator now), and the pages and Macs ask often, so repeated reads come from
 * the cache. Every write goes to both. A value read after a cache miss is cached only briefly.
 */
let SP_ = null;
let IN_LOCK = false;
function sp_() {
  if (SP_) return SP_;
  const props = PropertiesService.getScriptProperties();
  const cache = CacheService.getScriptCache();
  const NONE = '\u0000none';
  const memo = {};
  const ck = function (k) { return 'P|' + k; };
  const put = function (k, v, ttl) { try { cache.put(ck(k), v, ttl); } catch (e) { /* too big for the cache: fine */ } };
  SP_ = {
    getProperty: function (k) {
      if (IN_LOCK) { const f = props.getProperty(k); memo[k] = f; put(k, f === null ? NONE : f, 21600); return f; } // exact inside a lock
      if (Object.prototype.hasOwnProperty.call(memo, k)) return memo[k];
      let v = cache.get(ck(k));
      if (v === null || v === undefined) { v = props.getProperty(k); put(k, v === null ? NONE : v, 10); }
      else if (v === NONE) v = null;
      memo[k] = v;
      return v;
    },
    setProperty: function (k, v) { v = String(v); props.setProperty(k, v); memo[k] = v; put(k, v, 21600); return SP_; },
    deleteProperty: function (k) { props.deleteProperty(k); memo[k] = null; put(k, NONE, 21600); return SP_; },
    /** Fresh value straight from the store (inside a lock, before changing it). */
    fresh: function (k) { const v = props.getProperty(k); memo[k] = v; return v; },
    getKeys: function () { return props.getKeys(); }
  };
  return SP_;
}
function adminEmail_() { return norm_(sp_().getProperty(PROP.OWNER_EMAIL)); }

/* ---------------- sign-in sessions ---------------- */

const SESSION_DAYS = 30;
let CURRENT_EMAIL = ''; // set only by api() from a valid session

function sessionKey_() {
  let k = sp_().getProperty('SESSION_KEY');
  if (!k) {
    k = withLock_(function () { // the very first sign-in: made once, even if two people sign in at the same moment
      let x = sp_().getProperty('SESSION_KEY');
      if (!x) { x = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); sp_().setProperty('SESSION_KEY', x); }
      return x;
    });
  }
  return k;
}
function dailyLimit_(name, max) {
  const cache = CacheService.getScriptCache();
  const key = 'DL_' + name + '_' + new Date().toISOString().slice(0, 10);
  const n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), 21600);
  if (n > max) throw new Error('Too many sign-ins today. Try again tomorrow, or tell the app administrator.');
}
/** At most `max` times a minute for everyone together (protects the daily limits from anyone calling in a loop). */
function rateLimit_(name, max) {
  const cache = CacheService.getScriptCache();
  const key = 'RL_' + name + '_' + Math.floor(Date.now() / 60000);
  const n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), 120);
  if (n > max) throw new Error('Too many tries right now. Wait a minute and try again.');
}
function b64u_(text) { return Utilities.base64EncodeWebSafe(String(text), Utilities.Charset.UTF_8).replace(/=+$/, ''); }
function sign_(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(String(text), sessionKey_())).replace(/=+$/, '');
}
/** A signed note "this browser is <email> until <date>". Nothing else is kept on the server. */
function makeSession_(email) {
  const body = b64u_(norm_(email)) + '.' + (Date.now() + SESSION_DAYS * 86400000);
  return body + '.' + sign_(body);
}
function readSession_(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[2].length < 20) return '';
  const body = parts[0] + '.' + parts[1];
  if (sign_(body) !== parts[2]) return '';
  if (!(Number(parts[1]) > Date.now())) return '';
  try {
    const p = parts[0] + '==='.slice((parts[0].length + 3) % 4);
    return norm_(Utilities.newBlob(Utilities.base64DecodeWebSafe(p)).getDataAsString());
  } catch (e) { return ''; }
}

/**
 * The ONE door from the page: api(session, name, args). Only the actions listed here can be called, and only with a
 * valid session; the signed-in email comes from the session, never from the browser.
 */
function api(session, name, args) {
  SP_ = null;
  const email = readSession_(session);
  if (!email) throw new Error('SIGNED_OUT: Please sign in again.');
  const actions = apiActions_();
  if (!Object.prototype.hasOwnProperty.call(actions, name)) throw new Error('Unknown action.');
  CURRENT_EMAIL = email;
  TABLE_MEMO = {};
  try {
    return actions[name].apply(null, Array.isArray(args) ? args : []);
  } finally {
    CURRENT_EMAIL = ''; WS = null; TABLE_MEMO = null;
  }
}

/** What the page may ask for (everything else is server-only). */
function apiActions_() {
  return {
    getBootstrap: getBootstrap, createMyWorkspace: createMyWorkspace, switchWorkspace: switchWorkspace, renameWorkspace: renameWorkspace,
    addMember: addMember, removeMember: removeMember, saveShop: saveShop,
    getShopData: getShopData, importContacts: importContacts, markOptedOut: markOptedOut, saveTemplate: saveTemplate, deleteTemplate: deleteTemplate,
    getCampaignPreview: getCampaignPreview, startCampaign: startCampaign, pauseCampaign: pauseCampaign, resumeCampaign: resumeCampaign,
    stopCampaign: stopCampaign, getCampaignDetail: getCampaignDetail, logWhatsAppOpened: logWhatsAppOpened,
    getWhatsAppJob: getWhatsAppJob, importWhatsAppResults: importWhatsAppResults, getWhatsAppHelper: getWhatsAppHelper,
    startWhatsAppAuto: startWhatsAppAuto, stopWhatsAppAuto: stopWhatsAppAuto, openWhatsAppOnMac: openWhatsAppOnMac, createMacLink: createMacLink,
    getSettings: getSettings, saveOAuthClient: saveOAuthClient, startGmailConnect: startGmailConnect, finishGmailConnect: finishGmailConnect,
    testGmailAccount: testGmailAccount, disconnectGmailAccount: disconnectGmailAccount, assignShopSender: assignShopSender,
    saveSendingRules: saveSendingRules, restartEngine: restartEngine,
    saveWhatsAppApi: saveWhatsAppApi, refreshWhatsAppTemplates: refreshWhatsAppTemplates, disconnectWhatsAppApi: disconnectWhatsAppApi,
    getWhatsAppApiTemplates: getWhatsAppApiTemplates, getWhatsAppApiPreview: getWhatsAppApiPreview, startWhatsAppApiCampaign: startWhatsAppApiCampaign,
    renameList: renameList, removeList: removeList,
    saveWebsite: saveWebsite, getSheetJs: getSheetJs,
    startMediaUpload: startMediaUpload, uploadMediaChunk: uploadMediaChunk, removeMedia: removeMedia
  };
}

/** "Sign in with Google": Google's page asks only to share the email address (no warning screen). */
function startLogin() {
  SP_ = null;
  rateLimit_('login', 300);
  migrate_();
  const client = oauthClient_();
  const state = Utilities.getUuid();
  CacheService.getScriptCache().put('LOGIN_' + state, '1', 900);
  const q = { client_id: client.id, redirect_uri: redirectUri_(), response_type: 'code', scope: 'openid email',
    prompt: 'select_account', access_type: 'online', state: state };
  return OAUTH.AUTH_URL + '?' + Object.keys(q).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); }).join('&');
}

/** The administrator's one-time first sign-in link (made by setup). */
function finishFirstLogin(token) {
  SP_ = null;
  return withLock_(function () {
    const saved = String(sp_().getProperty('FIRST_LOGIN') || '').split('|');
    if (!saved[0] || saved[0] !== sha256Hex_(String(token || '')) || !(Number(saved[1]) > Date.now())) {
      throw new Error('This first sign-in link was already used or has expired. Click "Sign in with Google".');
    }
    sp_().deleteProperty('FIRST_LOGIN');
    return { session: makeSession_(adminEmail_()), email: adminEmail_() };
  });
}

/** Google sends the person back with a one-time code; the server asks Google who it is and returns a session. */
function finishLogin(code, state, error) {
  SP_ = null;
  const cache = CacheService.getScriptCache();
  const key = 'LOGIN_' + String(state || '');
  if (!cache.get(key)) throw new Error('This sign-in link expired or was already used. Click "Sign in with Google" again.');
  cache.remove(key);
  rateLimit_('loginfinish', 60);
  dailyLimit_('loginfinish', 2000); // well below Google's daily limit of outside requests (Gmail sending needs it)
  if (error) throw new Error(error === 'access_denied' ? 'Sign-in was cancelled. Click "Sign in with Google" again.' : 'Google returned an error: ' + error);
  const client = oauthClient_();
  const res = UrlFetchApp.fetch(OAUTH.TOKEN_URL, {
    method: 'post', muteHttpExceptions: true,
    payload: { code: code, client_id: client.id, client_secret: client.secret, redirect_uri: redirectUri_(), grant_type: 'authorization_code' }
  });
  const body = parseJson_(res.getContentText());
  if (res.getResponseCode() !== 200 || !body.id_token) {
    throw new Error('Google did not finish the sign-in (' + (body.error_description || body.error || res.getResponseCode()) + '). Try again.');
  }
  const id = decodeJwtPayload_(body.id_token);
  const email = norm_(id.email);
  if (!email || id.email_verified === false || String(id.aud) !== client.id ||
      ['accounts.google.com', 'https://accounts.google.com'].indexOf(String(id.iss)) === -1) {
    throw new Error('Google did not confirm the email address of that account.');
  }
  revoke_(body.access_token); // only the email was needed
  return { session: makeSession_(email), email: email };
}

function readJsonProp_(key, fallback) {
  try { const v = sp_().getProperty(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}
/** Size in bytes (UTF-8): Google's limits are in bytes, and Arabic letters take 2 bytes each. */
function byteLen_(s) { return unescape(encodeURIComponent(String(s))).length; }
function writeJsonProp_(key, obj) {
  const s = JSON.stringify(obj);
  if (byteLen_(s) > 8800) throw new Error('Too much data to save in one setting.');
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
/** Changes only some fields of a workspace, on its newest saved copy. */
function patchWs_(id, patch) {
  const ws = getWs_(id);
  if (!ws) return null;
  Object.keys(patch).forEach(function (k) { if (patch[k] === null) delete ws[k]; else ws[k] = patch[k]; });
  saveWs_(ws);
  return ws;
}

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

function canUseWs_(ws, email) {
  return !!(ws && !ws.broken && (ws.owner === email || (ws.members || []).indexOf(email) !== -1));
}
/** Workspaces this person can open, own first. */
function workspaceIds_(rec) {
  const ids = [];
  if (rec.own && canUseWs_(getWs_(rec.own), rec.email)) ids.push(rec.own);
  rec.member.forEach(function (id) { if (ids.indexOf(id) === -1 && canUseWs_(getWs_(id), rec.email)) ids.push(id); });
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
      // The id is saved first, so a run that stopped half-way continues with the same workspace.
      let id = props.getProperty('WS_MIGRATION_ID');
      if (!id) { id = newId_('W'); props.setProperty('WS_MIGRATION_ID', id); }
      const ws = { id: id, owner: owner, sheet_id: sheetId, name: 'My shops', created_at: nowIso_(),
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
    if (props.getProperty('WS_VERSION') !== WS_VERSION) migrateToAdminRun_(props);
    props.setProperty('WS_VERSION', WS_VERSION);
    try { CacheService.getScriptCache().remove('P|WS_VERSION'); } catch (e) { /* fine */ }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Version 3: the app now runs as the administrator. People who were Editors of a workspace's Sheet become its
 * members (Dad keeps access). A workspace whose Sheet is in someone else's Drive (made with the previous sign-in)
 * cannot be opened by the app any more: it is marked, and its owner simply creates a new one.
 */
function migrateToAdminRun_(props) {
  const admin = norm_(props.getProperty(PROP.OWNER_EMAIL));
  const due = {};
  props.getKeys().forEach(function (k) {
    if (k.indexOf('NEXT_DUE@') === 0) { const v = Number(props.getProperty(k)); if (v) due[k.slice(9)] = v; props.deleteProperty(k); }
  });
  props.setProperty('DUE_INDEX', JSON.stringify(due));
  props.getKeys().filter(function (k) { return k.indexOf('W_') === 0; }).forEach(function (k) {
    let ws; try { ws = JSON.parse(props.getProperty(k)); } catch (e) { return; }
    if (!ws || ws.members) return;
    let ss = null;
    try { ss = SpreadsheetApp.openById(ws.sheet_id); } catch (e) { ss = null; }
    if (!ss) { ws.broken = true; ws.members = []; props.setProperty(k, JSON.stringify(ws)); return; }
    ws.members = editorsOf_(ss).filter(function (e) { return e && e !== ws.owner && e !== admin; });
    props.setProperty(k, JSON.stringify(ws));
    ws.members.forEach(function (m) {
      const key = userKey_(m);
      let r = {}; try { r = JSON.parse(props.getProperty(key) || '{}'); } catch (e) { r = {}; }
      r.member = Array.isArray(r.member) ? r.member : [];
      if (r.member.indexOf(ws.id) === -1) r.member.unshift(ws.id);
      props.setProperty(key, JSON.stringify({ own: r.own || '', member: r.member, current: r.current || ws.id, checked: true }));
    });
  });
}

function signedInEmail_() {
  if (!CURRENT_EMAIL) throw new Error('SIGNED_OUT: Please sign in again.');
  return CURRENT_EMAIL;
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
  const rec = userRec_(email);
  const ids = workspaceIds_(rec);
  const id = ids.indexOf(rec.current) !== -1 ? rec.current : ids[0];
  if (!id) {
    if (rec.own && getWs_(rec.own) && getWs_(rec.own).broken) {
      const e = new Error('Your workspace was made with the earlier sign-in and must be made again: click "Create my workspace".');
      e.noWorkspace = true; e.remade = true; throw e;
    }
    throw noWorkspaceError_();
  }
  const ws = getWs_(id);
  let ss;
  try { ss = SpreadsheetApp.openById(ws.sheet_id); } catch (e) {
    const m = String(e && e.message || e);
    if (/not found|does not exist|deleted|missing/i.test(m)) {
      throw new Error('The Google Sheet of the workspace "' + ws.name + '" was deleted. ' + adminEmail_() +
        ' (the app administrator) can restore it from the trash of their Google Drive; then reload this page.');
    }
    throw new Error('Google could not open the workspace "' + ws.name + '" right now (' + m + '). Wait a minute and reload the page.');
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

/** First visit: makes this person's own workspace (a new Google Sheet, shared with them) with their first shop. */
function createMyWorkspace(name, firstShopName) {
  migrate_();
  if (!adminEmail_()) throw new Error('The app is not set up yet.');
  const email = signedInEmail_();
  const wsName = String(name || '').trim().slice(0, 60) || 'My shops';
  const shopName = String(firstShopName || '').trim().slice(0, 80);
  if (!shopName) throw new Error('Write the name of your first shop (you can add more later).');
  return withLock_(function () {
    const rec = userRec_(email);
    const old = rec.own ? getWs_(rec.own) : null;
    if (old && !old.broken) throw new Error('You already have your own workspace. Reload the page.');
    const ss = SpreadsheetApp.create(APP_NAME + ' — ' + wsName + ' (' + email + ')');
    prepareSheet_(ss, shopName);
    try { ss.addEditor(email); } catch (e) { /* they can still use everything in the app */ }
    const ws = { id: newId_('W'), owner: email, sheet_id: ss.getId(), name: wsName, created_at: nowIso_(), members: [] };
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
  return withLock_(function () { patchWs_(ctx.ws.id, { name: n }); return n; });
}

function membersOf_(ctx) {
  return (getWs_(ctx.ws.id).members || []).slice().sort();
}

/** Owner: lets another Google account use this workspace through the app (not by editing the Sheet). */
function addMember(email) {
  const ctx = requireOwner_();
  const addr = norm_(email);
  if (!isValidEmail_(addr)) throw new Error('Write the person\'s Google (Gmail) address.');
  if (addr === ctx.email) throw new Error('That is you — you already own this workspace.');
  return withLock_(function () {
    const ws = getWs_(ctx.ws.id);
    const members = ws.members || [];
    if (members.indexOf(addr) === -1) members.push(addr);
    if (members.length > 30) throw new Error('A workspace can have at most 30 people.');
    patchWs_(ws.id, { members: members });
    const rec = userRec_(addr);
    if (rec.member.indexOf(ctx.ws.id) === -1) rec.member.push(ctx.ws.id);
    saveUserRec_(rec);
    return membersOf_(ctx);
  });
}

/** Owner: removes a person's access. */
function removeMember(email) {
  const ctx = requireOwner_();
  const addr = norm_(email);
  if (addr === ctx.ws.owner) throw new Error('The owner cannot be removed.');
  return withLock_(function () {
    patchWs_(ctx.ws.id, { members: (getWs_(ctx.ws.id).members || []).filter(function (m) { return m !== addr; }) });
    try { ctx.ss.removeEditor(addr); } catch (e) { /* was not an editor */ }
    const rec = userRec_(addr);
    if (!rec.isNew) {
      rec.member = rec.member.filter(function (x) { return x !== ctx.ws.id; });
      if (rec.current === ctx.ws.id) rec.current = '';
      saveUserRec_(rec);
    }
    const ws = getWs_(ctx.ws.id);
    if (ws.mac_token && norm_(ws.mac_linked_by) === addr) revokeMac_(ws); // their Mac stops too
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

/* ---------------- the one every-minute trigger (the administrator's) ---------------- */

/** (Re)installs the every-minute sending trigger. The app runs as the administrator, so it is theirs. */
function installTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processQueue') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processQueue').timeBased().everyMinutes(1).create();
  try { CacheService.getScriptCache().put('TRIGGER_OK', '1', 21600); } catch (e) { /* best effort */ }
}

/** Puts the sender back if it was removed (checked at most every 6 hours). */
function ensureTrigger_() {
  const cache = CacheService.getScriptCache();
  if (cache.get('TRIGGER_OK')) return true;
  if (norm_(Session.getEffectiveUser().getEmail()) !== adminEmail_()) return false;
  const has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'processQueue'; });
  if (!has) installTrigger_();
  cache.put('TRIGGER_OK', '1', 21600);
  return true;
}

/* ---------------- which workspaces have sends due (one setting, read every minute) ---------------- */

function dueIndex_() { try { return JSON.parse(sp_().fresh('DUE_INDEX') || '{}'); } catch (e) { return {}; } }
function setDue_(wsId, ms) {
  const idx = dueIndex_();
  if (ms) idx[wsId] = ms; else delete idx[wsId];
  sp_().setProperty('DUE_INDEX', JSON.stringify(idx));
}
