/**
 * Gmail accounts connected with Google OAuth 2.0, and sending through the Gmail API.
 *
 * Why not GmailApp: GmailApp can only send from the Google account that runs the script (and that account's
 * "Send mail as" aliases). It cannot send from separately connected Gmail accounts. So each shop's Gmail account
 * is connected with OAuth (scope gmail.send only) and email is sent with the Gmail API through UrlFetchApp.
 *
 * Where secrets live:
 *  - OAuth client secret and every account's refresh/access token: the OWNER's UserProperties.
 *    Only code running as the owner (the owner's own web session, or the owner's trigger) can read them.
 *    They are never returned to the web page and never written to the Google Sheet.
 *  - Script properties hold only non-secret status: which addresses are connected, last test, last error.
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
const OAUTH_CALLBACK_URL = 'https://hebadaher.github.io/sheetsender/callback.html';

/* ------------------------------------------------------------------ */
/* Storage helpers                                                      */
/* ------------------------------------------------------------------ */

/** The owner's private store. Throws unless the code is running as the owner. */
function ownerSecrets_() {
  const owner = norm_(PropertiesService.getScriptProperties().getProperty(PROP.OWNER_EMAIL));
  const me = norm_(Session.getEffectiveUser().getEmail());
  if (!owner || me !== owner) throw new Error('Only the owner account can use Gmail connections.');
  return PropertiesService.getUserProperties();
}

function accountStatus_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(PROP.ACCOUNTS) || '{}'); } catch (e) { return {}; }
}

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
  PropertiesService.getScriptProperties().setProperty(PROP.ACCOUNTS, JSON.stringify(all));
  return acc;
}

function redirectUri_() {
  return OAUTH_CALLBACK_URL;
}

function oauthClient_() {
  const id = PropertiesService.getScriptProperties().getProperty(PROP.OAUTH_CLIENT_ID) || '';
  const secret = ownerSecrets_().getProperty(SECRET.CLIENT_SECRET) || '';
  if (!id || !secret) throw new Error('Google sign-in is not configured yet. Owner: open Settings > Google sign-in and save the Client ID and Client secret.');
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
  const props = PropertiesService.getScriptProperties();
  const shops = readTable_(ctx.ss, TABS.SHOPS).rows.filter(function (s) { return s.shop_id; });
  const accounts = accountStatus_();
  const list = Object.keys(accounts).sort().map(function (k) {
    const a = accounts[k];
    return {
      email: k, status: a.status, connected_at: a.connected_at || '', last_ok_at: a.last_ok_at || '',
      last_test_at: a.last_test_at || '', last_error: a.last_error || '',
      shops: shops.filter(function (s) { return norm_(s.sender_email) === k; }).map(function (s) { return s.shop_name || s.shop_id; })
    };
  });
  const uri = redirectUri_();
  return {
    redirectUri: uri,
    redirectLooksWrong: false,
    clientId: props.getProperty(PROP.OAUTH_CLIENT_ID) || '',
    clientSecretSaved: !!ownerSecrets_().getProperty(SECRET.CLIENT_SECRET),
    accounts: list,
    shops: shops.map(function (s) {
      const c = senderCheck_(s);
      return { shop_id: s.shop_id, shop_name: s.shop_name, sender_email: norm_(s.sender_email), active: isActive_(s.active), senderOk: c.ok, senderProblem: c.reason };
    }),
    engine: engineStatus_(),
    sheetUrl: ctx.ss.getUrl()
  };
}

/** Saves the OAuth client from Google Cloud. The secret goes only into the owner's private store. */
function saveOAuthClient(clientId, clientSecret) {
  requireOwner_();
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!/^[0-9]+-[a-z0-9_]+\.apps\.googleusercontent\.com$/i.test(id)) {
    throw new Error('That does not look like a Google Client ID. It ends with ".apps.googleusercontent.com".');
  }
  const store = ownerSecrets_();
  if (!secret && !store.getProperty(SECRET.CLIENT_SECRET)) throw new Error('Paste the Client secret too.');
  if (secret && !/^[A-Za-z0-9_\-]{10,}$/.test(secret)) throw new Error('That does not look like a Google Client secret.');
  PropertiesService.getScriptProperties().setProperty(PROP.OAUTH_CLIENT_ID, id);
  if (secret) store.setProperty(SECRET.CLIENT_SECRET, secret);
  return { clientId: id, clientSecretSaved: true };
}

/** Returns the Google consent URL. The owner opens it, signs in as the shop's Gmail and clicks Allow. */
function startGmailConnect(loginHint) {
  requireOwner_();
  const client = oauthClient_();
  const state = Utilities.getUuid();
  CacheService.getUserCache().put('oauth_state_' + state, JSON.stringify({ hint: norm_(loginHint), at: nowIso_() }), 900);
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

/** Older redirect target (the web app itself). Kept so an old Cloud setting still works when only one account is signed in. */
function oauthCallbackPage_(p) {
  let ok = false, title, detail;
  try {
    const email = completeConnect_(p);
    ok = true;
    title = 'Connected: ' + email;
    detail = 'This Gmail account can now send emails for the app. Close this tab and go back to the app ' +
      '(Settings > Gmail accounts), then choose this account for a shop and click Test.';
  } catch (e) {
    title = 'Not connected';
    detail = e.message;
  }
  const html = '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>' +
    'body{font:16px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f5f6f8;color:#1d2433;margin:0;padding:40px 16px}' +
    '.c{max-width:560px;margin:0 auto;background:#fff;border:1px solid #dfe3ea;border-radius:12px;padding:24px}' +
    'h1{font-size:22px;margin:0 0 10px;color:' + (ok ? '#1f7a3a' : '#b42318') + '}a{color:#0f6e5c;font-weight:600}</style></head><body><div class="c">' +
    '<h1>' + (ok ? '✓ ' : '') + escapeHtml_(title) + '</h1><p>' + escapeHtml_(detail) + '</p>' +
    '<p><a href="' + escapeHtml_(String(ScriptApp.getService().getUrl() || '')) + '" target="_top">Back to the app</a></p></div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle(APP_NAME + ' — Gmail connection');
}

function completeConnect_(p) {
  let ctx;
  try {
    ctx = requireOwner_();
  } catch (e) {
    const owner = PropertiesService.getScriptProperties().getProperty(PROP.OWNER_EMAIL) || 'the owner';
    throw new Error('This page must open while the browser is signed in to Google as ' + owner + ' (the app owner) first. ' +
      'Open the app with that account, go to Settings and click Connect again. (' + e.message + ')');
  }
  const cache = CacheService.getUserCache();
  const key = 'oauth_state_' + String(p.state || '');
  const saved = cache.get(key);
  if (!saved) throw new Error('This connection link has expired or was already used. In the app, click Connect again.');
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
    const old = parseJson_(store.getProperty(SECRET.TOKEN_PREFIX + email) || '{}');
    if (old.refresh_token && old.refresh_token !== body.refresh_token) revoke_(old.refresh_token);
    store.setProperty(SECRET.TOKEN_PREFIX + email, JSON.stringify({
      refresh_token: body.refresh_token,
      access_token: body.access_token,
      expires_at: Date.now() + (Number(body.expires_in || 3600) * 1000)
    }));
    markAccount_(email, 'connected', '', { connected_at: nowIso_(), connected_by: ctx.email });
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
      subject: APP_NAME + ': test email',
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
    const tok = parseJson_(store.getProperty(SECRET.TOKEN_PREFIX + addr) || '{}');
    revoke_(tok.refresh_token);
    store.deleteProperty(SECRET.TOKEN_PREFIX + addr);
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

function restartEngine() {
  requireOwner_();
  installTrigger_();
  PropertiesService.getScriptProperties().setProperty(PROP.LAST_ENGINE_RUN, nowIso_());
  return engineStatus_();
}

/* ------------------------------------------------------------------ */
/* Tokens and sending (run as the owner: owner session or owner trigger) */
/* ------------------------------------------------------------------ */

function getAccessToken_(email, forceRefresh) {
  const addr = norm_(email);
  const store = ownerSecrets_();
  const tok = parseJson_(store.getProperty(SECRET.TOKEN_PREFIX + addr) || '{}');
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
    store.setProperty(SECRET.TOKEN_PREFIX + addr, JSON.stringify(tok));
    return tok.access_token;
  }
  if (body.error === 'invalid_grant' || body.error === 'unauthorized_client' || res.getResponseCode() === 401) {
    store.deleteProperty(SECRET.TOKEN_PREFIX + addr);
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
  lines.push(
    'Subject: ' + encodeWord_(msg.subject),
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
