/**
 * Gmail accounts connected with Google OAuth 2.0, and sending through the Gmail API.
 *
 * Why not GmailApp: GmailApp can only send from the Google account that runs the script (and that account's
 * "Send mail as" aliases). It cannot send from separately connected Gmail accounts. So each shop's Gmail account
 * is connected with OAuth (scope gmail.send only) and email is sent with the Gmail API through UrlFetchApp.
 *
 * Where secrets live:
 *  - Every Gmail account's refresh/access token: the UserProperties of the WORKSPACE OWNER who connected it.
 *    Only code running as that owner (their own web session, or their own trigger) can read them.
 *  - The OAuth client secret (one Google sign-in client for the whole app, made by the administrator): script
 *    properties, read only by server code. Never returned to any web page, never written to any Sheet.
 *  - Per-workspace status (which addresses are connected, last test, last error) has no secrets.
 */

const OAUTH = {
  AUTH_URL: 'https://accounts.google.com/o/oauth2/v2/auth',
  TOKEN_URL: 'https://oauth2.googleapis.com/token',
  REVOKE_URL: 'https://oauth2.googleapis.com/revoke',
  SEND_URL: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
  SEND_SCOPE: 'https://www.googleapis.com/auth/gmail.send',
  // openid + email only identify WHICH address was connected; gmail.send is the only Gmail permission.
  SCOPES: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send']
};
const SECRET = { CLIENT_SECRET: 'OAUTH_CLIENT_SECRET', TOKEN_PREFIX: 'GMAIL_TOKEN_' };

/**
 * Where Google sends people back after they click Allow. A small static page (on GitHub Pages) hands the result
 * back to the app's Settings tab, which finishes the connection in the OWNER's session. This avoids Google's
 * "unable to open the file" error when the browser is signed in to several Google accounts at once.
 * Must be listed exactly under "Authorized redirect URIs" of the OAuth client in Google Cloud.
 */
const OAUTH_CALLBACK_URL = 'https://hebadaher.github.io/sheetsender/callback.html'; // earlier versions only

/* ------------------------------------------------------------------ */
/* Storage helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * The private server store (the administrator's UserProperties: only this app's server code can read it).
 * From a page, only the OWNER of the open workspace may use it; the sending trigger and the Mac bridge (no person
 * signed in) use it for the workspace they are working on.
 */
function ownerSecrets_() {
  if (!WS || !WS.owner) throw new Error('Only the workspace owner account can use these connections.');
  if (CURRENT_EMAIL && CURRENT_EMAIL !== WS.owner) throw new Error('Only the workspace owner account can use these connections.');
  if (norm_(Session.getEffectiveUser().getEmail()) !== adminEmail_()) throw new Error('Only the workspace owner account can use these connections.');
  return PropertiesService.getUserProperties();
}

/** Each workspace's Gmail tokens have their own names (the administrator's original workspace keeps its old ones). */
function gmailTokenKey_(email) {
  const legacy = WS.owner === adminEmail_() && WS.id === userRec_(adminEmail_()).own;
  return SECRET.TOKEN_PREFIX + (legacy ? '' : WS.id + '_') + norm_(email);
}

function accountStatus_() { return wsJson_('ACCOUNTS', {}) || {}; }

function markAccount_(email, status, error, extra) {
  const all = accountStatus_();
  const key = norm_(email);
  const now = nowIso_();
  const acc = all[key] || { email: key };
  acc.status = status;
  acc.last_error = error || '';
  if (status === 'connected') acc.last_ok_at = now;
  Object.keys(extra || {}).forEach(function (k) { acc[k] = extra[k]; });
  acc.updated_at = now;
  all[key] = acc;
  wsSet_('ACCOUNTS', JSON.stringify(all));
  return acc;
}

/**
 * Where Google sends people back after signing in or clicking Allow: the app's own link (/exec). The one-time code
 * then arrives only in the app itself, in the browser that asked for it — never through another page.
 * APP_URL is written by Install.command (App.config.gs); this exact address must be an "Authorized redirect URI"
 * of the OAuth client in Google Cloud.
 */
function redirectUri_() {
  if (typeof APP_URL !== 'undefined' && /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(String(APP_URL))) return String(APP_URL);
  const url = String(ScriptApp.getService().getUrl() || '');
  if (/\/exec$/.test(url)) return url;
  throw new Error('The app link is not known yet. The administrator must run Install.command once more.');
}

/**
 * The client secret. Earlier versions kept it in the administrator's private store; it moves (once, when the
 * administrator's code runs) to server-only script properties so every workspace owner's trigger can use it.
 */
function clientSecret_() {
  const props = sp_();
  let secret = props.getProperty(PROP.OAUTH_CLIENT_SECRET) || '';
  if (!secret && norm_(Session.getEffectiveUser().getEmail()) === adminEmail_()) {
    const mine = PropertiesService.getUserProperties();
    secret = mine.getProperty(SECRET.CLIENT_SECRET) || '';
    if (secret) { props.setProperty(PROP.OAUTH_CLIENT_SECRET, secret); mine.deleteProperty(SECRET.CLIENT_SECRET); }
  }
  return secret;
}

function oauthClient_() {
  const id = sp_().getProperty(PROP.OAUTH_CLIENT_ID) || '';
  const secret = clientSecret_();
  if (!id || !secret) {
    throw new Error('Google sign-in is not configured yet. The app administrator (' + adminEmail_() +
      ') must open Settings > Google sign-in and save the Client ID and Client secret.');
  }
  return { id: id, secret: secret };
}

function senderError_(kind, message) {
  const e = new Error(message);
  e.kind = kind; // AUTH | QUOTA | BAD_RECIPIENT | TEMP | FAIL
  return e;
}

function parseJson_(text) { try { return JSON.parse(text); } catch (e) { return {}; } }

/* ------------------------------------------------------------------ */
/* Owner API used by the Settings page                                  */
/* ------------------------------------------------------------------ */

function getSettings() {
  const ctx = requireOwner_();
  if (ctx.ws.engine_on) ensureTrigger_();
  const props = sp_();
  const shops = readTable_(ctx.ss, TABS.SHOPS).rows.filter(function (s) { return s.shop_id; });
  const accounts = accountStatus_();
  const list = Object.keys(accounts).sort().map(function (k) {
    const a = accounts[k];
    return {
      email: k, status: a.status, connected_at: a.connected_at || '', last_ok_at: a.last_ok_at || '',
      last_test_at: a.last_test_at || '', last_error: a.last_error || '',
      shops: shops.filter(function (s) { return norm_(s.sender_email) === k && isActive_(s.active); }).map(function (s) { return s.shop_name || s.shop_id; })
    };
  });
  const clientId = props.getProperty(PROP.OAUTH_CLIENT_ID) || '';
  const secretSaved = !!clientSecret_();
  return {
    isAdmin: ctx.isAdmin,
    admin: adminEmail_(),
    workspace: { id: ctx.ws.id, name: ctx.ws.name || 'My shops', owner: ctx.ws.owner },
    members: membersOf_(ctx),
    redirectUri: redirectUri_(),
    redirectLooksWrong: false,
    clientId: ctx.isAdmin ? clientId : '',
    clientSecretSaved: secretSaved,
    clientReady: !!clientId && secretSaved,
    accounts: list,
    shops: shops.map(function (s) {
      const c = senderCheck_(s);
      return { shop_id: s.shop_id, shop_name: s.shop_name, sender_email: norm_(s.sender_email), sender_name: s.sender_name,
        reply_to: s.reply_to, country_code: s.country_code || DEFAULT_COUNTRY_CODE,
        active: isActive_(s.active), senderOk: c.ok, senderProblem: c.reason };
    }),
    engine: engineStatus_(),
    sendingRules: sendingRules_(),
    sentToday: (function () {
      const logRows = readTable_(ctx.ss, TABS.LOG).rows;
      return list.map(function (a) { return { email: a.email, n: sentTodayBy_(logRows, a.email, Date.now()) }; });
    })(),
    waApi: waApiPublic_(true),
    appUrl: String(ScriptApp.getService().getUrl() || ''),
    sheetUrl: ctx.ss.getUrl()
  };
}

/** Administrator: saves the OAuth client from Google Cloud. The secret is kept server-side only. */
function saveOAuthClient(clientId, clientSecret) {
  requireAdmin_();
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!/^[0-9]+-[a-z0-9_]+\.apps\.googleusercontent\.com$/i.test(id)) {
    throw new Error('That does not look like a Google Client ID. It ends with ".apps.googleusercontent.com".');
  }
  if (!secret && !clientSecret_()) throw new Error('Paste the Client secret too.');
  if (secret && !/^[A-Za-z0-9_\-]{10,}$/.test(secret)) throw new Error('That does not look like a Google Client secret.');
  const props = sp_();
  props.setProperty(PROP.OAUTH_CLIENT_ID, id);
  if (secret) props.setProperty(PROP.OAUTH_CLIENT_SECRET, secret);
  return { clientId: id, clientSecretSaved: true };
}

/** Returns the Google consent URL. The workspace owner opens it, signs in as the shop's Gmail and clicks Allow. */
function startGmailConnect(loginHint) {
  requireOwner_();
  const client = oauthClient_();
  const state = Utilities.getUuid();
  CacheService.getScriptCache().put('oauth_state_' + state, JSON.stringify({ hint: norm_(loginHint), by: CURRENT_EMAIL, ws: WS.id, at: nowIso_() }), 900);
  const q = {
    client_id: client.id,
    redirect_uri: redirectUri_(),
    response_type: 'code',
    scope: OAUTH.SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'select_account consent',
    include_granted_scopes: 'false',
    state: state
  };
  if (loginHint) q.login_hint = norm_(loginHint);
  return OAUTH.AUTH_URL + '?' + Object.keys(q).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]);
  }).join('&');
}

/**
 * Called by the owner's Settings page with the code + state that the callback page handed back.
 * Returns the connected address.
 */
function finishGmailConnect(code, state, error) {
  return completeConnect_({ code: code, state: state, error: error });
}

function completeConnect_(p) {
  let ctx;
  try {
    ctx = requireOwner_();
  } catch (e) {
    throw new Error('Finish the connection in the app tab where you clicked Connect, signed in as the owner of the workspace. ' +
      'Open the app with that account, go to Settings and click Connect again. (' + e.message + ')');
  }
  const cache = CacheService.getScriptCache();
  const key = 'oauth_state_' + String(p.state || '');
  const saved = parseJson_(cache.get(key) || '');
  if (!saved.ws) throw new Error('This connection link has expired or was already used. In the app, click Connect again.');
  if (saved.by !== ctx.email || saved.ws !== ctx.ws.id) {
    throw new Error('This connection was started by another account or workspace. In the app, click Connect again.');
  }
  cache.remove(key);
  if (p.error) {
    throw new Error(p.error === 'access_denied'
      ? 'Permission was not given (Cancel was clicked). In the app, click Connect again and click Allow.'
      : 'Google returned an error: ' + p.error);
  }
  const client = oauthClient_();
  const res = UrlFetchApp.fetch(OAUTH.TOKEN_URL, {
    method: 'post', muteHttpExceptions: true,
    payload: { code: p.code, client_id: client.id, client_secret: client.secret, redirect_uri: redirectUri_(), grant_type: 'authorization_code' }
  });
  const body = parseJson_(res.getContentText());
  if (res.getResponseCode() !== 200) {
    throw new Error('Google refused the connection: ' + (body.error_description || body.error || res.getResponseCode()) +
      '. Check that the Redirect URI in Google Cloud is exactly ' + redirectUri_());
  }
  const scopes = String(body.scope || '').split(/\s+/);
  if (scopes.indexOf(OAUTH.SEND_SCOPE) === -1) {
    revoke_(body.access_token);
    throw new Error('The box "Send email on your behalf" was not ticked, so the app cannot send. Click Connect again and tick it.');
  }
  if (!body.refresh_token) {
    throw new Error('Google did not give a lasting permission. Click Connect again (if it repeats, remove the app at myaccount.google.com/permissions first).');
  }
  const idPayload = decodeJwtPayload_(body.id_token);
  const email = norm_(idPayload.email);
  if (!email || idPayload.email_verified === false) throw new Error('Google did not confirm the email address of that account.');

  return withLock_(function () {
    const store = ownerSecrets_();
    const old = parseJson_(store.getProperty(gmailTokenKey_(email)) || '{}');
    if (old.refresh_token && old.refresh_token !== body.refresh_token) revoke_(old.refresh_token);
    store.setProperty(gmailTokenKey_(email), JSON.stringify({
      refresh_token: body.refresh_token,
      access_token: body.access_token,
      expires_at: Date.now() + (Number(body.expires_in || 3600) * 1000)
    }));
    markAccount_(email, 'connected', '', { connected_at: nowIso_(), connected_by: ctx.email });
    ensureTrigger_();
    return email;
  });
}

function decodeJwtPayload_(jwt) {
  const part = String(jwt || '').split('.')[1];
  if (!part) return {};
  const padded = part + '==='.slice((part.length + 3) % 4);
  return parseJson_(Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString());
}

function revoke_(token) {
  if (!token) return;
  try {
    UrlFetchApp.fetch(OAUTH.REVOKE_URL, { method: 'post', payload: { token: token }, muteHttpExceptions: true });
  } catch (e) { /* best effort */ }
}

/** Sends a test email from the account to itself. */
function testGmailAccount(email) {
  const ctx = requireOwner_();
  const addr = norm_(email);
  if (!accountStatus_()[addr]) throw new Error('That account is not in the list.');
  try {
    sendGmail_({
      from: addr, fromName: APP_NAME, to: addr,
      subject: APP_NAME + ': test email', noUnsubscribe: true,
      text: 'This is a test from ' + APP_NAME + '.\n\nThe Gmail account ' + addr + ' is connected and can send emails for the app.\n\nTested by ' + ctx.email + '.'
    });
  } catch (e) {
    throw new Error('Test failed for ' + addr + ': ' + e.message);
  }
  markAccount_(addr, 'connected', '', { last_test_at: nowIso_() });
  return { ok: true, message: 'Test email sent from ' + addr + ' to itself. Check that inbox.' };
}

/** Removes the app's permission for this account and stops all sending from it. */
function disconnectGmailAccount(email) {
  const ctx = requireOwner_();
  const addr = norm_(email);
  return withLock_(function () {
    const store = ownerSecrets_();
    const tok = parseJson_(store.getProperty(gmailTokenKey_(addr)) || '{}');
    revoke_(tok.refresh_token);
    store.deleteProperty(gmailTokenKey_(addr));
    markAccount_(addr, 'disconnected', 'Disconnected by ' + ctx.email);
    const table = readTable_(ctx.ss, TABS.CAMPAIGNS);
    let paused = 0;
    table.rows.forEach(function (c) {
      if (c.status === 'running' && norm_(c.sender_email) === addr) {
        c.status = 'paused';
        c.status_reason = 'The Gmail account ' + addr + ' was disconnected. Reconnect it in Settings, then press Resume.';
        updateRow_(table, c);
        paused++;
      }
    });
    recomputeNextDue_(table.rows);
    return { ok: true, paused: paused };
  });
}

/** Chooses which connected Gmail account sends for a shop (writes the address, never a token, to the Shops tab). */
function assignShopSender(shopId, email) {
  const ctx = requireOwner_();
  const addr = norm_(email);
  if (addr) {
    const acc = accountStatus_()[addr];
    if (!acc || acc.status !== 'connected') throw new Error(addr + ' is not a connected Gmail account. Connect it first.');
  }
  return withLock_(function () {
    const table = readTable_(ctx.ss, TABS.SHOPS);
    const shop = table.rows.filter(function (s) { return s.shop_id === shopId; })[0];
    if (!shop) throw new Error('Shop not found.');
    shop.sender_email = addr;
    updateRow_(table, shop);
    return publicShop_(shop);
  });
}

/** Workspace owner: saves the safe-sending rules. */
function saveSendingRules(rules) {
  requireOwner_();
  rules = rules || {};
  const cap = Math.round(Number(rules.dailyCap)), start = Math.round(Number(rules.startHour)), end = Math.round(Number(rules.endHour));
  if (!(cap >= 5 && cap <= 400)) throw new Error('Emails per day must be between 5 and 400. 20–50 is safest.');
  if (!(start >= 0 && start <= 23) || !(end >= 1 && end <= 24) || end <= start) throw new Error('Choose sending hours where the end is after the start.');
  if (end - start < 2) throw new Error('Allow at least 2 sending hours per day.');
  const saved = { dailyCap: cap, startHour: start, endHour: end };
  wsSet_('SEND_RULES', JSON.stringify(saved));
  return sendingRules_();
}

function restartEngine() {
  requireOwner_();
  installTrigger_();
  wsSet_('LAST_RUN', nowIso_());
  return engineStatus_();
}

/* ------------------------------------------------------------------ */
/* Tokens and sending (run as the workspace owner: their session or trigger) */
/* ------------------------------------------------------------------ */

function getAccessToken_(email, forceRefresh) {
  const addr = norm_(email);
  const store = ownerSecrets_();
  const tok = parseJson_(store.getProperty(gmailTokenKey_(addr)) || '{}');
  if (!tok.refresh_token) {
    throw senderError_('AUTH', 'The Gmail account ' + addr + ' is not connected.');
  }
  if (!forceRefresh && tok.access_token && Number(tok.expires_at) - 60000 > Date.now()) return tok.access_token;
  const client = oauthClient_();
  const res = UrlFetchApp.fetch(OAUTH.TOKEN_URL, {
    method: 'post', muteHttpExceptions: true,
    payload: { client_id: client.id, client_secret: client.secret, refresh_token: tok.refresh_token, grant_type: 'refresh_token' }
  });
  const body = parseJson_(res.getContentText());
  if (res.getResponseCode() === 200 && body.access_token) {
    tok.access_token = body.access_token;
    tok.expires_at = Date.now() + Number(body.expires_in || 3600) * 1000;
    store.setProperty(gmailTokenKey_(addr), JSON.stringify(tok));
    return tok.access_token;
  }
  if (body.error === 'invalid_grant' || body.error === 'unauthorized_client' || res.getResponseCode() === 401) {
    store.deleteProperty(gmailTokenKey_(addr));
    markAccount_(addr, 'needs_reconnect', 'Google says the permission expired or was removed');
    throw senderError_('AUTH', 'The permission for ' + addr + ' expired or was removed.');
  }
  if (body.error === 'invalid_client') {
    throw senderError_('AUTH', 'The Client ID or secret in Settings is wrong or was deleted in Google Cloud.');
  }
  throw senderError_('TEMP', 'Google sign-in service did not answer (' + res.getResponseCode() + ').');
}

/** Sends one email through the Gmail API as msg.from. Throws errors with .kind (see senderError_). */
function sendGmail_(msg) {
  const raw = Utilities.base64EncodeWebSafe(buildMime_(msg), Utilities.Charset.UTF_8);
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = getAccessToken_(msg.from, attempt > 0);
    const res = UrlFetchApp.fetch(OAUTH.SEND_URL, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ raw: raw })
    });
    const code = res.getResponseCode();
    if (code === 200) return parseJson_(res.getContentText()).id || '';
    const err = (parseJson_(res.getContentText()).error) || {};
    const reason = ((err.errors || [])[0] || {}).reason || err.status || '';
    const text = err.message || ('HTTP ' + code);
    if (code === 401 && attempt === 0) continue; // access token expired early: refresh once and retry
    if (code === 401 || (code === 403 && /insufficient|PERMISSION|scope/i.test(reason + ' ' + text))) {
      markAccount_(msg.from, 'needs_reconnect', 'Gmail refused the permission (' + text + ')');
      throw senderError_('AUTH', 'Gmail refused the permission for ' + msg.from + '.');
    }
    if ((code === 403 || code === 429) && /dailyLimit|Daily user sending limit|quota/i.test(reason + ' ' + text)) {
      throw senderError_('QUOTA', 'Daily sending limit of ' + msg.from + ' reached.');
    }
    if (code === 429 || code >= 500) throw senderError_('TEMP', 'Gmail is busy (' + text + ').');
    if (code === 400 && /recipient|To header|address/i.test(text)) throw senderError_('BAD_RECIPIENT', 'Gmail rejected the address: ' + text);
    throw senderError_('FAIL', 'Gmail error: ' + text);
  }
  throw senderError_('TEMP', 'Gmail did not accept the email.');
}

function headerSafe_(v) { return String(v || '').replace(/[\r\n]+/g, ' ').trim(); }

function encodeWord_(text) {
  return '=?UTF-8?B?' + Utilities.base64Encode(headerSafe_(text), Utilities.Charset.UTF_8) + '?=';
}

function base64Lines_(text) {
  return Utilities.base64Encode(String(text || ''), Utilities.Charset.UTF_8).replace(/(.{76})/g, '$1\r\n');
}

/** Builds a UTF-8 multipart (plain text + HTML) email. Header values are stripped of line breaks. */
function buildMime_(msg) {
  const boundary = 'sf_' + Utilities.getUuid().replace(/-/g, '');
  const from = headerSafe_(msg.from), to = headerSafe_(msg.to);
  if (!isValidEmail_(to)) throw senderError_('BAD_RECIPIENT', 'Invalid email address: ' + to);
  const lines = [
    'From: ' + (msg.fromName ? encodeWord_(msg.fromName) + ' ' : '') + '<' + from + '>',
    'To: <' + to + '>'
  ];
  if (msg.replyTo && isValidEmail_(msg.replyTo)) lines.push('Reply-To: <' + headerSafe_(msg.replyTo) + '>');
  const domain = from.split('@')[1] || 'gmail.com';
  lines.push(
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + Utilities.getUuid() + '.' + Date.now() + '@' + domain + '>',
    'Subject: ' + encodeWord_(msg.subject));
  if (!msg.noUnsubscribe) {
    // Lets mail apps show an "Unsubscribe" button, so people can say "stop" instead of pressing "Report spam".
    const unsubTo = (msg.replyTo && isValidEmail_(msg.replyTo)) ? headerSafe_(msg.replyTo) : from;
    lines.push('List-Unsubscribe: <mailto:' + unsubTo + '?subject=' + encodeURIComponent('Unsubscribe ' + to) + '>');
  }
  lines.push(
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines_(msg.text),
    '--' + boundary,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines_(msg.html || textToHtml_(msg.text)),
    '--' + boundary + '--',
    ''
  );
  return lines.join('\r\n');
}
